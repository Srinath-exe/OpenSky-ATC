/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  allowedDevOrigins: ['157.173.218.70', 'localhost'],
  poweredByHeader: false,
  // /api/voice/stt runs Whisper on onnxruntime-node, which transformers.js loads through createRequire: the file tracer
  // cannot see it, so the standalone bundle lists it here (CPU binaries only; the CUDA/TensorRT providers are 500 MB).
  outputFileTracingIncludes: {
    '/api/voice/stt': [
      './node_modules/onnxruntime-node/package.json',
      './node_modules/onnxruntime-node/dist/*.js',
      './node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node',
      './node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1',
      './node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_shared.so',
      './node_modules/onnxruntime-common/**/*',
      // transformers.js imports its own sharp (0.35, libvips 8.18) at load; the tracer misses the native libraries
      './node_modules/@huggingface/transformers/node_modules/@img/sharp-linux-x64/**/*',
      './node_modules/@huggingface/transformers/node_modules/@img/sharp-libvips-linux-x64/**/*',
    ],
  },
  // /api/voice/gold reads and writes ml/data/gold of the checkout at run time (outside the bundle); without this the
  // tracer copies all of ml/ (datasets, checkpoints) and mobile/ (Flutter build) into .next/standalone (~5 GB).
  outputFileTracingExcludes: {
    '*': ['./ml/**', './mobile/**'],
  },
  // The baked worlds and the aircraft models are large and immutable per version (their URLs carry ?v=): cache them for
  // a year so a returning player downloads nothing but the page. Everything else keeps Next's revalidation defaults.
  async headers() {
    return [
      { source: '/world/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
      { source: '/models/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    ]
  },
}
module.exports = nextConfig
