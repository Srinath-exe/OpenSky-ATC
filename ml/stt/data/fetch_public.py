"""Download the public ATC speech corpora (Hugging Face parquet) into ml/data/stt/raw/<name>/.
    ml/stt/.venv/bin/python ml/stt/data/fetch_public.py
Licences (ml/stt/DATA.md): UWB-ATCC CC BY-NC-SA 4.0; ATCOSIM free of charge, commercial use not granted -> non-commercial;
ATCO2 test 1h under the ATCO2 end-user agreement -> evaluation only."""
from pathlib import Path
from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parents[3]
REPOS = {"uwb_atcc": "Jzuluaga/uwb_atcc", "atcosim": "Jzuluaga/atcosim_corpus", "atco2_1h": "Jzuluaga/atco2_corpus_1h"}
for name, repo in REPOS.items():
    d = snapshot_download(repo_id=repo, repo_type="dataset", local_dir=ROOT / "ml/data/stt/raw" / name, allow_patterns=["*.parquet", "README.md"])
    print(name, sorted(str(p.relative_to(d)) for p in Path(d).rglob("*.parquet")), flush=True)
