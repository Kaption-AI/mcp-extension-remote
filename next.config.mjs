/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // NOTE: security headers are deliberately NOT configured here.
  //
  // A `headers()` rule matching every route is unrepresentable across the two
  // path-to-regexp versions in this stack: Next's config validator (15.5 at the time) rejects
  // the v8 wildcard ('/*path' -> "Unexpected MODIFIER"), while
  // @opennextjs/cloudflare's routingHandler runs path-to-regexp v8, which
  // rejects the classic '/(.*)' ("Unexpected ("). The v6 form '/:path*' fails
  // under v8 as well. With '/(.*)' in place the router threw on EVERY dynamic
  // request, so the whole site returned 500 while static assets still served.
  //
  // The headers are applied in the worker instead (src/index.ts), which already
  // wraps each response — one place, no route matching, nothing to break on a
  // future dependency bump.
};

export default nextConfig;
