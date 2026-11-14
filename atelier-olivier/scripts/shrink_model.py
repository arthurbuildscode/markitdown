#!/usr/bin/env python3
"""Réduit de moitié la taille d'un modèle ONNX : les poids sont stockés en float16
et reconvertis en float32 au chargement (nœuds Cast repliés par ONNX Runtime).
Le calcul reste en float32, donc compatible partout.

  python scripts/shrink_model.py models/colorize.onnx
"""
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

path = sys.argv[1]
model = onnx.load(path)
graph = model.graph
casts, converted = [], 0
for init in list(graph.initializer):
    if init.data_type != TensorProto.FLOAT or np.prod(init.dims) < 2048:
        continue
    values = numpy_helper.to_array(init)
    if np.abs(values).max() > 6e4:
        continue
    half = numpy_helper.from_array(values.astype(np.float16), init.name + "_f16")
    casts.append(helper.make_node("Cast", [half.name], [init.name], to=TensorProto.FLOAT, name="cast_" + init.name))
    graph.initializer.remove(init)
    graph.initializer.append(half)
    converted += 1
for node in reversed(casts):
    graph.node.insert(0, node)
onnx.checker.check_model(model)
onnx.save(model, path)
print(f"{converted} tenseurs convertis en float16 -> {path}")
