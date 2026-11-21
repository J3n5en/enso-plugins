const decoder = new TextDecoder('utf-8', { fatal: true });
module.exports = (buf) => {
  try {
    decoder.decode(buf);
    return true;
  } catch {
    return false;
  }
};
