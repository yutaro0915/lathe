/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@lathe/acp-client", "@lathe/domain", "@lathe/shared"],
};

export default nextConfig;
