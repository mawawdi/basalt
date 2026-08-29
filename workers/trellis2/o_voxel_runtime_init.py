"""Basalt's fixed O-Voxel runtime surface.

The upstream package imports its GLB postprocessor at module import time. That
postprocessor imports nvdiffrast even though TRELLIS.2 inference only needs the
conversion and serialization kernels. The qualified runtime installs this
exact replacement before building O-Voxel so the excluded renderer can never
enter the inference process.
"""

from . import convert, io, rasterize, serialize

__all__ = ["convert", "io", "rasterize", "serialize"]
