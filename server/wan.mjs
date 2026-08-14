/** 外网一体服：静态页面 + WebSocket 中继 */
process.env.LUMENFOLD_SERVE_STATIC = "1";
await import("./relay.mjs");
