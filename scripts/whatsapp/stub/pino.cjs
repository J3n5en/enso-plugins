// Baileys 默认用 pino 打日志；插件只用自己的静默 logger，凭据不会经它落进日志
const noop = () => {};
const make = () => {
  const logger = { level: 'silent', child: () => make() };
  for (const k of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) logger[k] = noop;
  return logger;
};
module.exports = make;
module.exports.default = make;
