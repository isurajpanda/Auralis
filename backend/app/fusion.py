from app.config import FUSION_WEIGHTS, risk_level

def fuse_scores(model_scores: dict) -> tuple[float, str]:
    """
    Weighted average of model probabilities -> 0-100
    model_scores: {"aasist":0.1, "rawnet2":0.2, "xlsr":0.15}
    """
    total = 0.0
    weight_sum = 0.0
    for name, score in model_scores.items():
        w = FUSION_WEIGHTS.get(name, 0.33)
        total += score * w
        weight_sum += w
    if weight_sum > 0:
        fused_prob = total / weight_sum  # 0..1 (weights already normalized, but safe)
    else:
        fused_prob = total / len(model_scores) if model_scores else 0
    # If weights are normalized, fused_prob == total
    # Recompute correctly when normalized: total already is weighted sum
    # Use direct weighted sum if sum~1
    if abs(weight_sum - 1.0) < 1e-6:
        fused_prob = total
    fused_score = fused_prob * 100.0
    fused_score = max(0.0, min(100.0, fused_score))
    level = risk_level(fused_score)
    return fused_score, level
