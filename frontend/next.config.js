/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/backend/:path*',
        destination: `${process.env.BACKEND_URL || 'http://backend:8900'}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
