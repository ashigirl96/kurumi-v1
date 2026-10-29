export function relayProgram(port: number): string {
  return `
const { createServer, connect } = require('node:net');
const { lookup } = require('node:dns/promises');
const { networkInterfaces } = require('node:os');
const addresses = () => Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
const uplink = new Set(addresses());
const { address: target } = await lookup('host.docker.internal', { family: 4 });
console.log('resolved ' + target);
const deadline = Date.now() + 30000;
let host;
while (!(host = addresses().find(a => !uplink.has(a)))) {
  if (Date.now() >= deadline) throw new Error('private interface not attached');
  await Bun.sleep(25);
}
${forwarderProgram(port)}
server.listen(${port}, host, () => console.log('listening ' + host));
`
}

export function forwarderProgram(port: number): string {
  return `
const server = createServer({ allowHalfOpen: true }, downstream => {
  const upstream = connect({ host: target, port: ${port}, allowHalfOpen: true });
  const close = () => { downstream.destroy(); upstream.destroy(); };
  const connecting = setTimeout(close, 10000);
  upstream.once('connect', () => clearTimeout(connecting));
  upstream.once('close', () => clearTimeout(connecting));
  for (const socket of [downstream, upstream]) {
    socket.setTimeout(300000, close);
    socket.on('error', close);
  }
  downstream.on('close', () => upstream.destroy());
  upstream.on('close', () => downstream.destroy());
  downstream.pipe(upstream);
  upstream.pipe(downstream);
});
server.maxConnections = 128;
`
}
