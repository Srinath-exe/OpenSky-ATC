import { TaxiNode, TaxiEdge } from '@/lib/types';

interface GraphEdge {
  from: string;
  to: string;
  weight: number;
  name: string;
}

function dist(a: {x:number;y:number}, b: {x:number;y:number}): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx*dx + dy*dy);
}

export function buildGraph(nodes: TaxiNode[], edges: TaxiEdge[]): Map<string, GraphEdge[]> {
  const nodeMap = new Map<string, TaxiNode>();
  nodes.forEach(n => nodeMap.set(n.id, n));
  const adj = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const fromNode = nodeMap.get(e.fromNodeId);
    const toNode = nodeMap.get(e.toNodeId);
    if (!fromNode || !toNode) continue;
    const w = dist(fromNode.localPosition!, toNode.localPosition!);
    if (!adj.has(e.fromNodeId)) adj.set(e.fromNodeId, []);
    if (!adj.has(e.toNodeId)) adj.set(e.toNodeId, []);
    adj.get(e.fromNodeId)!.push({ from: e.fromNodeId, to: e.toNodeId, weight: w, name: e.name });
    if (!e.isOneWay) {
      adj.get(e.toNodeId)!.push({ from: e.toNodeId, to: e.fromNodeId, weight: w, name: e.name });
    }
  }
  return adj;
}

export function astar(
  adj: Map<string, GraphEdge[]>,
  nodes: TaxiNode[],
  startId: string,
  goalId: string
): TaxiNode[] | null {
  const nodeMap = new Map<string, TaxiNode>();
  nodes.forEach(n => nodeMap.set(n.id, n));
  const goalNode = nodeMap.get(goalId);
  if (!goalNode) return null;
  const openSet = new Set<string>([startId]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();
  nodes.forEach(n => {
    gScore.set(n.id, Infinity);
    fScore.set(n.id, Infinity);
  });
  gScore.set(startId, 0);
  fScore.set(startId, dist(nodeMap.get(startId)!.localPosition!, goalNode.localPosition!));

  while (openSet.size > 0) {
    let current = '';
    let bestF = Infinity;
    for (const id of openSet) {
      const s = fScore.get(id)!;
      if (s < bestF) { bestF = s; current = id; }
    }
    if (current === goalId) {
      const path: TaxiNode[] = [];
      let p = goalId;
      while (cameFrom.has(p)) {
        path.unshift(nodeMap.get(p)!);
        p = cameFrom.get(p)!;
      }
      path.unshift(nodeMap.get(p)!);
      return path;
    }
    openSet.delete(current);
    for (const edge of adj.get(current) ?? []) {
      const tentativeG = gScore.get(current)! + edge.weight;
      if (tentativeG < (gScore.get(edge.to) ?? Infinity)) {
        cameFrom.set(edge.to, current);
        gScore.set(edge.to, tentativeG);
        fScore.set(edge.to, tentativeG + dist(nodeMap.get(edge.to)!.localPosition!, goalNode.localPosition!));
        openSet.add(edge.to);
      }
    }
  }
  return null;
}
