"""
任务分配算法：连通集 → 多组交叉验证分配
"""
from typing import Any, Dict, List

import numpy as np


def distribute_units_with_overlap(
    all_units: List[Dict[str, Any]],
    num_groups: int,
    overlap_factor: int
) -> List[List[Dict[str, Any]]]:
    """
    将标注基本单位（连通集）分配到 num_groups 个组中
    overlap_factor: 每个基本单位被几个组标注
        - 1 = 不重叠
        - 2 = 每个被 2 个组标过
        - N = 每个被 N 个组标过
    返回每个组的 unit 列表
    """
    if num_groups <= 0 or not all_units:
        return [[] for _ in range(num_groups)]

    if overlap_factor < 1:
        overlap_factor = 1
    if overlap_factor > num_groups:
        overlap_factor = num_groups

    rng = np.random.default_rng(seed=42)
    groups: List[List[Dict[str, Any]]] = [[] for _ in range(num_groups)]

    for unit in all_units:
        chosen = rng.choice(num_groups, size=overlap_factor, replace=False)
        for g in chosen:
            groups[int(g)].append(unit)

    return groups
