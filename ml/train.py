#!/usr/bin/env python3
"""Phase 4 ML scaffold — trains the model consumed by lib/analysis/model.ts.

CHANGE_RULES=ml runs a softmax (multinomial logistic) regression over the
per-pixel features exported by `npm run features`. This script is the only
training code: stdlib-only by default, with an automatic numpy fast path when
numpy is installed (no project dependency either way).

Usage:
  npm run features                                # artifacts/ml/features.csv
  python ml/train.py                              # artifacts/ml/model.json
  python ml/train.py --epochs 40 --holdout 0.25

Output JSON schema (MlModel, version 1):
  features[]  names in the canonical ML_FEATURES order
  classes[]   CLASS codes the model can emit (0..5)
  mean/std    standardisation of the RAW features: z = (x - mean) / std
  weights[c][k], bias[c]  softmax parameters for classes[c]
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import sys
from collections import defaultdict

# validation/engine.ts RefClass → CLASS code (lib/analysis/config.ts CLASS).
LABEL_TO_CODE = {
    "no_change": 0,
    "veg_gain": 1,
    "veg_loss": 2,
    "builtup_increase": 3,
    "water_gain": 4,
    "water_loss": 5,
}
CODE_TO_NAME = {code: name for name, code in LABEL_TO_CODE.items()}


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default=os.path.join("artifacts", "ml", "features.csv"))
    p.add_argument("--out", default=os.path.join("artifacts", "ml", "model.json"))
    p.add_argument("--epochs", type=int, default=30)
    p.add_argument("--lr", type=float, default=0.5, help="batch learning rate")
    p.add_argument("--l2", type=float, default=1e-4)
    p.add_argument("--batch", type=int, default=256)
    p.add_argument("--holdout", type=float, default=0.2, help="fraction held out for metrics")
    p.add_argument("--max-per-class", type=int, default=25000, help="cap after shuffle (0 = all)")
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args(argv)


def load_csv(path, max_per_class, seed):
    rng = random.Random(seed)
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        if header[:2] != ["scenario", "label"]:
            sys.exit(f"unexpected CSV header: {header[:2]}")
        features = header[2:]
        by_label = defaultdict(list)
        for row in reader:
            label = row[1]
            if label not in LABEL_TO_CODE:
                continue  # unknown vocabulary row — skip, never guess
            values = [float(v) for v in row[2:]]
            by_label[label].append(values)
    rows = []
    for label, items in by_label.items():
        rng.shuffle(items)
        if max_per_class > 0:
            items = items[:max_per_class]
        code = LABEL_TO_CODE[label]
        for values in items:
            rows.append((values, code))
    rng.shuffle(rows)
    return features, rows


def split(rows, holdout, seed):
    rng = random.Random(seed)
    rng.shuffle(rows)
    n_val = int(len(rows) * holdout)
    return rows[n_val:], rows[:n_val]


def standardise(train_rows, n_features):
    mean = [0.0] * n_features
    std = [0.0] * n_features
    for values, _ in train_rows:
        for k in range(n_features):
            mean[k] += values[k]
    count = max(1, len(train_rows))
    mean = [m / count for m in mean]
    for values, _ in train_rows:
        for k in range(n_features):
            d = values[k] - mean[k]
            std[k] += d * d
    std = [math.sqrt(s / count) or 1.0 for s in std]
    return mean, std


def train_numpy(train_rows, classes, n_features, args, seed):
    import numpy as np  # optional fast path — never required

    rng = np.random.default_rng(seed)
    X = np.array([v for v, _ in train_rows], dtype=np.float64)
    y = np.array([c for _, c in train_rows], dtype=np.int64)
    class_to_idx = {c: i for i, c in enumerate(classes)}
    Y = np.zeros((len(y), len(classes)), dtype=np.float64)
    Y[np.arange(len(y)), [class_to_idx[c] for c in y]] = 1.0
    # Inverse-frequency class weights (no_change dominates the rows).
    counts = np.maximum(Y.sum(axis=0), 1.0)
    cw = (len(y) / (len(classes) * counts)).astype(np.float64)

    W = np.zeros((len(classes), n_features), dtype=np.float64)
    b = np.zeros(len(classes), dtype=np.float64)
    n = len(X)
    for _ in range(args.epochs):
        order = rng.permutation(n)
        for start in range(0, n, args.batch):
            idx = order[start : start + args.batch]
            xb, yb, wb = X[idx], Y[idx], cw * Y[idx].sum(axis=0) / max(1, len(idx))
            logits = xb @ W.T + b
            logits -= logits.max(axis=1, keepdims=True)
            exp = np.exp(logits)
            probs = exp / exp.sum(axis=1, keepdims=True)
            diff = (probs - yb) * (wb * yb).sum(axis=1, keepdims=True)
            grad_w = diff.T @ xb / len(idx) + args.l2 * W
            grad_b = diff.mean(axis=0)
            W -= args.lr * grad_w
            b -= args.lr * grad_b
    return W.tolist(), b.tolist()


def train_python(train_rows, classes, n_features, args, seed):
    rng = random.Random(seed)
    W = [[0.0] * n_features for _ in classes]
    b = [0.0] * len(classes)
    # Inverse-frequency class weights (no_change dominates the rows).
    counts = defaultdict(int)
    for _, code in train_rows:
        counts[code] += 1
    total = max(1, len(train_rows))
    cw = {c: total / (len(classes) * max(1, counts[c])) for c in classes}

    for _ in range(args.epochs):
        rng.shuffle(train_rows)
        for start in range(0, len(train_rows), args.batch):
            batch = train_rows[start : start + args.batch]
            gw = [[0.0] * n_features for _ in classes]
            gb = [0.0] * len(classes)
            for values, code in batch:
                idx = classes.index(code)
                logits = [
                    b[c] + sum(W[c][k] * values[k] for k in range(n_features))
                    for c in range(len(classes))
                ]
                peak = max(logits)
                exps = [math.exp(z - peak) for z in logits]
                denom = sum(exps) or 1.0
                weight = cw[code]
                for c in range(len(classes)):
                    err = weight * ((exps[c] / denom) - (1.0 if c == idx else 0.0))
                    if err == 0.0:
                        continue
                    gb[c] += err
                    row_g = gw[c]
                    for k in range(n_features):
                        row_g[k] += err * values[k]
            scale = args.lr / len(batch)
            for c in range(len(classes)):
                b[c] -= scale * gb[c]
                for k in range(n_features):
                    # batch-mean gradient + L2 (weights read before update).
                    W[c][k] -= scale * gw[c][k] + args.lr * args.l2 * W[c][k]
    return W, b


def predict(values, mean, std, W, b, classes):
    z = [(values[k] - mean[k]) / std[k] for k in range(len(mean))]
    logits = [b[c] + sum(W[c][k] * z[k] for k in range(len(z))) for c in range(len(classes))]
    peak = max(logits)
    exps = [math.exp(v - peak) for v in logits]
    denom = sum(exps) or 1.0
    probs = [e / denom for e in exps]
    best = max(range(len(classes)), key=lambda i: probs[i])
    return classes[best], probs[best]


def metrics(rows, mean, std, W, b, classes):
    tp = defaultdict(int)
    fp = defaultdict(int)
    fn = defaultdict(int)
    for values, truth in rows:
        guess, _ = predict(values, mean, std, W, b, classes)
        if guess == truth:
            tp[truth] += 1
        else:
            fp[guess] += 1
            fn[truth] += 1
    lines = []
    f1s = []
    for code in sorted(CODE_TO_NAME):
        if code not in classes:
            continue
        prec = tp[code] / max(1, tp[code] + fp[code])
        rec = tp[code] / max(1, tp[code] + fn[code])
        f1 = 2 * prec * rec / max(1e-9, prec + rec)
        if tp[code] + fn[code] > 0:  # only classes present in the split
            f1s.append(f1)
        lines.append(
            f"    {CODE_TO_NAME[code]:<18} P={prec:.3f} R={rec:.3f} F1={f1:.3f}"
        )
    macro = sum(f1s) / max(1, len(f1s))
    return lines, macro


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    if not os.path.exists(args.data):
        sys.exit(f"missing {args.data} — run `npm run features` first")
    features, rows = load_csv(args.data, args.max_per_class, args.seed)
    if not rows:
        sys.exit("no training rows found")
    train_rows, val_rows = split(rows, args.holdout, args.seed)
    mean, std = standardise(train_rows, len(features))
    classes = sorted({code for _, code in rows})

    # Standardise once for the trainers (they read raw rows).
    def scaled(dataset):
        return [
            ([(v - mean[k]) / std[k] for k, v in enumerate(values)], code)
            for values, code in dataset
        ]

    train_s = scaled(train_rows)

    try:
        import numpy  # noqa: F401

        W, b = train_numpy(train_s, classes, len(features), args, args.seed)
        backend = "numpy"
    except ImportError:
        W, b = train_python(train_s, classes, len(features), args, args.seed)
        backend = "stdlib"

    # Metrics run on RAW rows — predict() applies the standardisation.
    lines, macro = metrics(val_rows, mean, std, W, b, classes)
    print(f"backend={backend} rows={len(rows)} train={len(train_s)} holdout={len(val_rows)}")
    print("holdout per-class metrics:")
    for line in lines:
        print(line)
    print(f"  macro F1 = {macro:.3f}")

    model = {
        "version": 1,
        "features": features,
        "classes": classes,
        "mean": mean,
        "std": std,
        "weights": W,
        "bias": b,
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(model, fh)
    print(f"wrote {args.out} ({os.path.getsize(args.out)} bytes)")
    print("enable with CHANGE_RULES=ml (needs a model file; ML_MODEL_PATH overrides).")


if __name__ == "__main__":
    main()
