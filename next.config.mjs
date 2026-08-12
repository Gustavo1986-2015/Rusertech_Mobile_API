/** @type {import('next').NextConfig} */
const nextConfig = {
  // Los route handlers son todos dinámicos: nunca cachear respuestas.
  experimental: { serverComponentsExternalPackages: ['pg'] },
};
export default nextConfig;
