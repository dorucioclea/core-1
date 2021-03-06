import { once } from 'events'
import { resolve } from 'path'
import { strict as assert } from 'assert'
import { NotFoundError } from 'common-errors'
import { PluginTypes, Microfleet, PluginInterface, ValidatorPlugin } from '@microfleet/core'
import { LoggerPlugin } from '@microfleet/plugin-logger'
import consul = require('consul')

/**
 * Consul configuration
 * https://www.npmjs.com/package/consul#init
 */
export type ConsulConfig = {
  base: consul.ConsulOptions;
  lock: Partial<consul.Lock.Options>;
}

/**
 * Plugin name
 */
export const name = 'consul'

/**
 * Defines service extension
 */
export interface ConsulPlugin {
  consul: consul.Consul;
  consulLeader: consul.Lock;
  whenLeader(): Promise<boolean>;
}

/**
 * Plugin Type
 */
export const type = PluginTypes.database

/**
 * Relative priority inside the same plugin group type
 */
export const priority = 0

/**
 * Attaches initialized validator based on conf.
 * Provides `consul` and `consulLeader` methods.
 * @param opts - Consul Configuration Object.
 */
export const attach = function attachConsulPlugin(
  this: Microfleet & ValidatorPlugin & LoggerPlugin & ConsulPlugin,
  opts: Partial<ConsulConfig> = {}
): PluginInterface {
  assert(this.hasPlugin('logger'), new NotFoundError('log module must be included'))
  assert(this.hasPlugin('validator'), new NotFoundError('validator module must be included'))

  // load local schemas
  this.validator.addLocation(resolve(__dirname, '../schemas'))

  const config = this.validator.ifError(name, opts) as ConsulConfig
  const base = { ...config.base, promisify: true }
  const lockConfig = {
    key: `microfleet/${this.config.name}/leader`,
    ...config.lock,
  }
  const { key } = lockConfig

  // expand core service
  let isLeader = false
  const instance = this[name] = consul(base)
  this.consulLeader = instance.lock(lockConfig)

  this.whenLeader = async () => {
    if (isLeader) {
      return true
    }

    await Promise.race([
      once(this.consulLeader, 'acquire'),
      once(this, 'close'),
    ])

    return isLeader
  }

  const onAcquire = (data?: any) => {
    if (data && data.reemit === true) {
      this.log.warn({ data }, 'skipping reemit')
      return
    }

    isLeader = true
    this.log.info({ key, leader: true }, 'acquired leader')
    this.emit('leader', key)
  }

  const onRelease = () => {
    isLeader = false
    this.log.info({ key, leader: false }, 'gracefully released')
  }

  const onEnd = () => {
    isLeader = false
    this.log.info({ key, leader: false }, 'lost leader')
    this.emit('follower', key)
    this.consulLeader.acquire()
  }

  const onNewListener = (event: string) => {
    this.log.info({ event }, 'adding new listener')

    if (event !== 'acquire' || !isLeader) {
      return
    }

    process.nextTick(() => {
      this.consulLeader.emit('acquire', { reemit: true })
    })
  }

  return {
    async connect(this: Microfleet & ConsulPlugin) {
      this.consulLeader.on('acquire', onAcquire)
      this.consulLeader.on('release', onRelease)
      this.consulLeader.on('end', onEnd)
      this.consulLeader.on('newListener', onNewListener)
      this.consulLeader.acquire()
    },

    async close(this: Microfleet & ConsulPlugin) {
      this.consulLeader.removeListener('acquire', onAcquire)
      this.consulLeader.removeListener('release', onRelease)
      this.consulLeader.removeListener('end', onEnd)
      this.consulLeader.removeListener('newListener', onNewListener)
      this.consulLeader.release()
      await once(this.consulLeader, 'end')
    },
  }
}
