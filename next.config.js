/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  allowedDevOrigins: ['157.173.218.70', 'localhost'],
  poweredByHeader: false,
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
