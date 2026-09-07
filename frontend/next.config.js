/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/backend/:path*',
        // 本地开发默认走 127.0.0.1；Docker 部署通过 BACKEND_URL 覆盖为服务名
        destination: `${process.env.BACKEND_URL || 'http://127.0.0.1:8900'}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
