/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@lathe/shared"],
  // The prototype uses Node's built-in `node:sqlite` (Node 24+). Built-in `node:`
  // modules are treated as external by Next automatically, so no extra config is
  // needed. (The lathe spec targets better-sqlite3; node:sqlite has a matching
  // synchronous API and is a drop-in for the prototype — see README.)
};

export default nextConfig;
