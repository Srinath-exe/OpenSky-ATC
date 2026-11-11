#!/usr/bin/env bash
# ATC ML GPU sessions on AWS (ml/README.md). Reuses the AWS setup of /root/project/llm (IAM user llm-gpu-orchestrator,
# security group llm-gpu-sg = SSH from this VPS only, tag Project=llm-gpu so that user may terminate it) but keeps its
# own state, so it never touches the image studio's instance.
#
#   ml/gpu/gpu.sh up [type]     launch (default g6.2xlarge), wait for SSH, run remote/setup.sh   ** costs money **
#   ml/gpu/gpu.sh push          rsync code + data to the instance
#   ml/gpu/gpu.sh jobs          start remote/jobs.sh in the background on the instance
#   ml/gpu/gpu.sh pull          rsync results back to ml/gpu/results/
#   ml/gpu/gpu.sh logs | status | ssh [cmd]
#   ml/gpu/gpu.sh down          terminate + delete the session key
# Failsafes: instance-initiated shutdown = terminate, and `shutdown -h +MAX_HOURS*60` at boot.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$HERE/state"; mkdir -p "$STATE"; chmod 700 "$STATE"
INST_FILE="$STATE/instance.env"; KEY="$STATE/id_ed25519"; KNOWN="$STATE/known_hosts"
set -a; . /root/project/llm/.env; set +a
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""; unset AWS_PROFILE
TYPE_DEFAULT=g6.2xlarge; MAX_HOURS="${MAX_HOURS:-3}"; ROOT_GB=100; SG_NAME=llm-gpu-sg; TAG=llm-gpu
AMI_PARAM=/aws/service/deeplearning/ami/x86_64/oss-nvidia-driver-gpu-pytorch-2.9-ubuntu-24.04/latest/ami-id
declare -A PRICE=([g6.xlarge]=0.805 [g6.2xlarge]=0.978 [g6.4xlarge]=1.323 [g5.2xlarge]=1.212)
SSH_OPTS=(-i "$KEY" -o UserKnownHostsFile="$KNOWN" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=30 -o BatchMode=yes)
log() { echo "[$(date +%H:%M:%S)] $*"; }; die() { echo "error: $*" >&2; exit 1; }
load() { [[ -f "$INST_FILE" ]] && . "$INST_FILE" || true; }
remote() { ssh "${SSH_OPTS[@]}" "ubuntu@$INSTANCE_IP" "$@"; }
state_of() { aws ec2 describe-instances --instance-ids "$1" --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo gone; }
cost() { local s=$(( $(date +%s) - LAUNCHED_AT )); awk -v s="$s" -v p="${PRICE[$INSTANCE_TYPE_RUNNING]:-1}" 'BEGIN{printf "%d min, ~$%.2f so far", s/60, s/3600*p}'; }

cmd_up() {
  local type="${1:-$TYPE_DEFAULT}"; load
  if [[ -n "${INSTANCE_ID:-}" ]] && [[ "$(state_of "$INSTANCE_ID")" =~ ^(pending|running)$ ]]; then log "already up: $INSTANCE_ID at $INSTANCE_IP"; return 0; fi
  rm -f "$INST_FILE"
  local sg; sg=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME --query 'SecurityGroups[0].GroupId' --output text)
  [[ "$sg" == sg-* ]] || die "security group $SG_NAME not found"
  local my_ip; my_ip=$(curl -s https://checkip.amazonaws.com)
  aws ec2 describe-security-groups --group-ids "$sg" --query 'SecurityGroups[0].IpPermissions[].IpRanges[].CidrIp' --output text | grep -q "$my_ip/32" \
    || aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$my_ip/32" >/dev/null
  rm -f "$KEY" "$KEY.pub" "$KNOWN"; ssh-keygen -q -t ed25519 -N "" -C atc-ml -f "$KEY"
  local key_name="atc-ml-$(date +%Y%m%d-%H%M%S)"
  aws ec2 import-key-pair --key-name "$key_name" --public-key-material "fileb://$KEY.pub" >/dev/null
  local ami; ami=$(aws ssm get-parameter --name "$AMI_PARAM" --query Parameter.Value --output text)
  local ud; ud=$(printf '#!/bin/bash\nshutdown -h +%d "atc-ml max lifetime reached"\n' "$((MAX_HOURS*60))")
  local vpc subnets; vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  subnets=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$vpc" Name=default-for-az,Values=true --query 'Subnets[].SubnetId' --output text)
  local id="" err
  for subnet in $subnets; do
    log "launching $type in $(aws ec2 describe-subnets --subnet-ids "$subnet" --query 'Subnets[0].AvailabilityZone' --output text) (auto-terminates after ${MAX_HOURS} h)"
    if id=$(aws ec2 run-instances --image-id "$ami" --instance-type "$type" --key-name "$key_name" \
        --security-group-ids "$sg" --subnet-id "$subnet" --instance-initiated-shutdown-behavior terminate --metadata-options HttpTokens=required \
        --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$ROOT_GB,\"VolumeType\":\"gp3\",\"Throughput\":400,\"Iops\":5000,\"DeleteOnTermination\":true}}]" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=$TAG},{Key=Name,Value=atc-ml}]" "ResourceType=volume,Tags=[{Key=Project,Value=$TAG}]" \
        --user-data "$ud" --query 'Instances[0].InstanceId' --output text 2>"$STATE/run.err"); then break; fi
    err=$(grep -o 'InsufficientInstanceCapacity\|Unsupported\|VcpuLimitExceeded\|UnauthorizedOperation' "$STATE/run.err" | head -1)
    log "  no luck: ${err:-$(tail -c 300 "$STATE/run.err")}"; id=""
    [[ "$err" =~ ^(VcpuLimitExceeded|UnauthorizedOperation)$ ]] && break
  done
  [[ -n "$id" ]] || { aws ec2 delete-key-pair --key-name "$key_name" >/dev/null 2>&1 || true; die "could not launch $type"; }
  printf 'INSTANCE_ID=%s\nINSTANCE_TYPE_RUNNING=%s\nLAUNCHED_AT=%s\nKEY_NAME=%s\nINSTANCE_IP=\n' "$id" "$type" "$(date +%s)" "$key_name" > "$INST_FILE"
  log "instance $id launched (billing starts now, \$${PRICE[$type]:-?}/h); waiting for it to run"
  aws ec2 wait instance-running --instance-ids "$id"
  INSTANCE_IP=$(aws ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
  sed -i "s/^INSTANCE_IP=.*/INSTANCE_IP=$INSTANCE_IP/" "$INST_FILE"
  log "running at $INSTANCE_IP; waiting for SSH"
  for _ in $(seq 60); do remote true 2>/dev/null && break; sleep 5; done
  remote true || die "SSH never came up (instance still running: ml/gpu/gpu.sh down)"
  cmd_push
  # SETUP=<script in ml/gpu/remote/> picks a session's own setup (default: setup.sh, the first session's packages + Kev)
  log "setup (${SETUP:-setup.sh})"; remote "bash /opt/atc/repo/ml/gpu/remote/${SETUP:-setup.sh}" 2>&1 | tail -20
}

cmd_push() {
  load; [[ -n "${INSTANCE_IP:-}" ]] || die "not up"
  remote "sudo mkdir -p /opt/atc && sudo chown ubuntu /opt/atc && mkdir -p /opt/atc/repo"
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" --exclude '.venv*' --exclude 'ext/' --exclude '__pycache__' --exclude 'ml/stt/out' \
    --exclude 'ml/data/out/*.jsonl' --exclude 'ml/data/out2/*.jsonl' --exclude 'ml/s1/runs' --exclude 'ml/gpu/state' --exclude 'ml/gpu/results' \
    --exclude 'venvs/' --exclude 'ml/stt/models' --exclude 'ml/stt/chrome' --exclude 'ml/verify/out' --exclude 'ml/diffusion/runs' --exclude 'ml/rl/runs' \
    --exclude 'ml/tts/cache' --exclude 'ml/data/gold' --exclude '*.pt' --exclude 'ml/data/stt/raw' --exclude 'ml/data/stt/synth/audio' --exclude 'ml/data/stt/synth2/audio' --exclude 'ml/data/stt/synth2/logs' \
    --include 'ml/***' --include 'tests/' --exclude '*' "$ROOT/" "ubuntu@$INSTANCE_IP:/opt/atc/repo/"
  log "pushed ml/ (code, datasets, tokenizer)"
}
cmd_jobs() { load; remote "cd /opt/atc/repo && mkdir -p /opt/atc/results && setsid nohup bash ml/gpu/remote/${JOBS:-jobs.sh} > /opt/atc/results/jobs.log 2>&1 < /dev/null & echo started"; }
cmd_pull() { load; mkdir -p "$HERE/results"; rsync -az -e "ssh ${SSH_OPTS[*]}" "ubuntu@$INSTANCE_IP:/opt/atc/results/" "$HERE/results/"; log "results in ml/gpu/results ($(cost))"; }
cmd_logs() { load; remote "tail -n ${1:-30} /opt/atc/results/jobs.log; nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader"; }
cmd_status() { load; [[ -n "${INSTANCE_ID:-}" ]] || { echo "no instance"; return; }; echo "$INSTANCE_ID $INSTANCE_TYPE_RUNNING $(state_of "$INSTANCE_ID") at $INSTANCE_IP, $(cost)"; }
cmd_down() {
  load; [[ -n "${INSTANCE_ID:-}" ]] || { echo "no instance"; return; }
  log "terminating $INSTANCE_ID ($(cost))"
  aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" >/dev/null || true
  aws ec2 delete-key-pair --key-name "$KEY_NAME" >/dev/null 2>&1 || true
  aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID" && log "terminated; billing stopped"
  mv "$INST_FILE" "$STATE/last-instance.env"
}
case "${1:-}" in
  up) shift; cmd_up "$@" ;; push) cmd_push ;; jobs) cmd_jobs ;; pull) cmd_pull ;; logs) shift; cmd_logs "$@" ;;
  status) cmd_status ;; ssh) load; shift; ssh "${SSH_OPTS[@]}" -o BatchMode=no "ubuntu@$INSTANCE_IP" "$@" ;; down) cmd_down ;;
  *) sed -n 2,13p "$0"; exit 1 ;;
esac
