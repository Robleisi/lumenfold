/**
 * 兼容旧入口：仅中继、不托管静态页（内网常用）
 * 等价于 LUMENFOLD_SERVE_STATIC=0 node server/relay.mjs
 */
process.env.LUMENFOLD_SERVE_STATIC = process.env.LUMENFOLD_SERVE_STATIC ?? "0";
await import("./relay.mjs");
