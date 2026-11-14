#!/usr/bin/env python3
"""Télécharge les poids open source et les convertit en ONNX pour l'Atelier d'Olivier.

  pip install torch onnx onnxruntime numpy
  python scripts/convert_models.py [dossier_cache]

Modèles :
  * Real-ESRGAN « realesr-general-x4v3 » (BSD-3-Clause, Xintao Wang et al.)
      -> models/upscale-x4.onnx      (amélioration de la définition)
  * Colorization « siggraph17 » (BSD-2-Clause, Richard Zhang, Phillip Isola, Alexei Efros et al.)
      -> models/colorize.onnx        (colorisation automatique)
"""
import os
import sys
import urllib.request

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "models")
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, ".model-cache")

SOURCES = {
    "realesr-general-x4v3.pth": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth",
    "siggraph17-df00044c.pth": "https://colorizers.s3.us-east-2.amazonaws.com/siggraph17-df00044c.pth",
}


def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print("téléchargement", SOURCES[name])
        urllib.request.urlretrieve(SOURCES[name], path)
    return path


# --- Real-ESRGAN (architecture SRVGGNetCompact) ------------------------------
class SRVGGNetCompact(nn.Module):
    def __init__(self, num_feat=64, num_conv=32, upscale=4):
        super().__init__()
        self.upscale = upscale
        body = [nn.Conv2d(3, num_feat, 3, 1, 1), nn.PReLU(num_parameters=num_feat)]
        for _ in range(num_conv):
            body += [nn.Conv2d(num_feat, num_feat, 3, 1, 1), nn.PReLU(num_parameters=num_feat)]
        body.append(nn.Conv2d(num_feat, 3 * upscale * upscale, 3, 1, 1))
        self.body = nn.ModuleList(body)
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        return out + F.interpolate(x, scale_factor=self.upscale, mode="nearest")


# --- Colorisation (architecture SIGGRAPHGenerator, Zhang et al. 2017) ---------
def _block(cin, cout, n, dilation=1, norm=True):
    layers = []
    for i in range(n):
        layers += [nn.Conv2d(cin if i == 0 else cout, cout, 3, 1, dilation, dilation=dilation), nn.ReLU(True)]
    if norm:
        layers.append(nn.BatchNorm2d(cout))
    return nn.Sequential(*layers)


class SiggraphColorizer(nn.Module):
    def __init__(self):
        super().__init__()
        self.model1 = _block(4, 64, 2)
        self.model2 = _block(64, 128, 2)
        self.model3 = _block(128, 256, 3)
        self.model4 = _block(256, 512, 3)
        self.model5 = _block(512, 512, 3, dilation=2)
        self.model6 = _block(512, 512, 3, dilation=2)
        self.model7 = _block(512, 512, 3)
        self.model8up = nn.Sequential(nn.ConvTranspose2d(512, 256, 4, 2, 1))
        self.model3short8 = nn.Sequential(nn.Conv2d(256, 256, 3, 1, 1))
        self.model8 = nn.Sequential(nn.ReLU(True), nn.Conv2d(256, 256, 3, 1, 1), nn.ReLU(True),
                                    nn.Conv2d(256, 256, 3, 1, 1), nn.ReLU(True), nn.BatchNorm2d(256))
        self.model9up = nn.Sequential(nn.ConvTranspose2d(256, 128, 4, 2, 1))
        self.model2short9 = nn.Sequential(nn.Conv2d(128, 128, 3, 1, 1))
        self.model9 = nn.Sequential(nn.ReLU(True), nn.Conv2d(128, 128, 3, 1, 1), nn.ReLU(True), nn.BatchNorm2d(128))
        self.model10up = nn.Sequential(nn.ConvTranspose2d(128, 128, 4, 2, 1))
        self.model1short10 = nn.Sequential(nn.Conv2d(64, 128, 3, 1, 1))
        self.model10 = nn.Sequential(nn.ReLU(True), nn.Conv2d(128, 128, 3, 1, 1), nn.LeakyReLU(0.2))
        self.model_class = nn.Sequential(nn.Conv2d(256, 529, 1))  # non utilisé, présent pour charger les poids
        self.model_out = nn.Sequential(nn.Conv2d(128, 2, 1), nn.Tanh())

    def forward(self, lum):
        """lum : L de CIE Lab (0..100), forme 1x1xHxW (H, W multiples de 8) -> ab, forme 1x2xHxW."""
        x = torch.cat(((lum - 50.0) / 100.0, lum * 0, lum * 0, lum * 0), dim=1)
        c1 = self.model1(x)
        c2 = self.model2(c1[:, :, ::2, ::2])
        c3 = self.model3(c2[:, :, ::2, ::2])
        c4 = self.model4(c3[:, :, ::2, ::2])
        c7 = self.model7(self.model6(self.model5(c4)))
        c8 = self.model8(self.model8up(c7) + self.model3short8(c3))
        c9 = self.model9(self.model9up(c8) + self.model2short9(c2))
        c10 = self.model10(self.model10up(c9) + self.model1short10(c1))
        return self.model_out(c10) * 110.0


def export(model, example, path, in_name, out_name):
    model.eval()
    torch.onnx.export(
        model, (example,), path, input_names=[in_name], output_names=[out_name], opset_version=17,
        dynamic_axes={in_name: {2: "h", 3: "w"}, out_name: {2: "oh", 3: "ow"}}, dynamo=False,
    )
    import onnxruntime as ort
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    for shape in (example.shape, example.shape[:2] + (example.shape[2] + 16, example.shape[3] - 24)):
        x = torch.rand(shape) * (100.0 if example.shape[1] == 1 else 1.0)
        with torch.no_grad():
            ref = model(x).numpy()
        got = sess.run(None, {in_name: x.numpy()})[0]
        err = float(np.abs(ref - got).max())
        print(f"  {os.path.basename(path)} {tuple(shape)} -> {got.shape}  écart max {err:.2e}")
        assert err < 1e-2, "la conversion ONNX diverge du modèle d'origine"
    print(f"  {os.path.getsize(path) / 1e6:.1f} Mo")


def main():
    os.makedirs(OUT, exist_ok=True)

    print("Real-ESRGAN general x4v3")
    sr = SRVGGNetCompact()
    state = torch.load(fetch("realesr-general-x4v3.pth"), map_location="cpu", weights_only=True)
    sr.load_state_dict(state.get("params_ema", state.get("params", state)), strict=True)
    export(sr, torch.rand(1, 3, 64, 64), os.path.join(OUT, "upscale-x4.onnx"), "image", "upscaled")

    print("Colorisation siggraph17")
    col = SiggraphColorizer()
    col.load_state_dict(torch.load(fetch("siggraph17-df00044c.pth"), map_location="cpu", weights_only=True), strict=True)
    export(col, torch.rand(1, 1, 64, 64) * 100, os.path.join(OUT, "colorize.onnx"), "lum", "ab")


if __name__ == "__main__":
    main()
