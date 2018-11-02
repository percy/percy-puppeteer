export function clientInfo(): string {
  const version: string = require('../package.json').version
  const name: string = require('../package.json').name
  return `${name}/${version}`
}
