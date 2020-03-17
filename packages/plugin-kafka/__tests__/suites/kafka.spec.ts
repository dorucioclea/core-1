import { Toxiproxy } from 'toxiproxy-node-client'
import { Microfleet } from '@microfleet/core'
import { Promise, TimeoutError } from 'bluebird'

import { once } from 'events'

import {
  KafkaFactory,
  // ConsumerStream,
  ProducerStream,
  TopicNotFoundError
} from '../../src'

let service: Microfleet
let producer: ProducerStream
let consumer: any

beforeEach(async () => {
  service = new Microfleet({
    name: 'tester',
    plugins: ['logger', 'validator', 'kafka'],
    kafka: {
      // debug: 'consumer,cgrp,topic,fetch',
      'metadata.broker.list': 'kafka:9092',
      'group.id': 'test-group',
      'fetch.wait.max.ms': 10,
    },
  })
})

afterEach(async () => {
  await service.close()
})

describe('connect', () => {
  test('should be able to create a producer stream', async () => {
    const { kafka } = service
    producer = await kafka.createProducerStream({
      streamOptions: { objectMode: false, topic: 'testBoo' },
    })

    expect(producer).toBeDefined()
  })

  test('should be able to create a consumer stream', async () => {
    const { kafka } = service

    producer = await kafka.createProducerStream({
      streamOptions: { objectMode: false, topic: 'testBoo' },
      conf: {
        dr_msg_cb: true,
      },
    })

    // if you need performance please avoid use cases like this
    producer.write('some')
    await once(producer.producer, 'delivery-report')

    consumer = await kafka.createConsumerStream({
      streamOptions: { topics: ['testBoo'] },
    })

    expect(consumer).toBeDefined()
  })

  describe('consumer missing topic', () => {
    test('with allTopics: true', async () => {
      const { kafka } = service

      const req = kafka.createConsumerStream({
        streamOptions: { topics: ['test-not-found'], connectOptions: { allTopics: true } },
      })

      await expect(req).rejects.toThrowError(TopicNotFoundError)
    })

    test('with topic: value', async () => {
      const { kafka } = service

      const req = kafka.createConsumerStream({
        streamOptions: { topics: ['test-not-found'], connectOptions: { topic: ['test-not-found'] } },
      })

      await expect(req).rejects.toThrowError(TopicNotFoundError)
    })
  })
})

describe('conn-track', () => {
  test('tracks streams', async () => {
    const kafka = service.kafka as KafkaFactory

    const streamToClose = await kafka.createProducerStream({
      streamOptions: { objectMode: false, topic: 'testBoo' },
      conf: { 'group.id': 'track-group' },
      topicConf: {},
    })

    const streamToCloseToo = await kafka.createConsumerStream({
      streamOptions: { topics: 'testBoo' },
      conf: { 'group.id': 'track-group' },
      topicConf: { 'auto.offset.reset': 'earliest' },
    })

    expect(kafka.getStreams().size).toEqual(2)

    await streamToClose.closeAsync()
    expect(kafka.getStreams().size).toEqual(1)

    await streamToCloseToo.closeAsync()
    expect(kafka.getStreams().size).toEqual(0)
  })

  test('closes streams on service shutdown', async () => {
    const kafka = service.kafka as KafkaFactory

    await kafka.createProducerStream({
      streamOptions: { objectMode: false, topic: 'testBoo' },
      conf: { 'group.id': 'track-close-group' },
    })

    await kafka.createConsumerStream({
      streamOptions: { topics: 'testBoo' },
      conf: { 'group.id': 'track-close-group' },
      topicConf: { 'auto.offset.reset': 'earliest' },
    })

    await service.close()

    expect(kafka.getStreams().size).toEqual(0)
  })

})

describe('connected to broker', () => {
  function getMessageIterable(count: number) {
    const sentMessages: any[] = []
    function* messagesToSend(topic: string) {
      for (let i = 0; i < count; i += 1) {
        const message = {
          topic,
          value: Buffer.from(`message ${i} at ${Date.now()}`),
        }
        sentMessages.push(message)
        yield message
      }
    }

    return {
      sentMessages,
      messagesToSend,
    }
  }

  test('consume/produce stopOnPartitionsEOF + no BatchMode', async () => {
    const { kafka } = service
    const topic = 'test-auto-commit-no-batch'
    const messagesToPublish = 11

    const messageIterable = getMessageIterable(messagesToPublish)

    producer = await kafka.createProducerStream({
      streamOptions: { objectMode: true, pollInterval: 1 },
      conf: {
        'group.id': 'auto-commit-producer',
        dr_msg_cb: true,
      },
    })

    const receivedMessages: any[] = []

    // we must wait for message delivery
    // otherwise we will try to create consumer,
    // but there will be no available topic metadata in Kafka
    for await (const message of messageIterable.messagesToSend(topic)) {
      producer.write(message)
      await once(producer.producer, 'delivery-report')
    }

    consumer = await kafka.createConsumerStream({
      streamOptions: {
        topics: topic,
        streamAsBatch: false,
        fetchSize: 2,
        stopOnPartitionsEOF: true,
        offsetQueryTimeout: 10,
        objectMode: true,
      },
      conf: {
        debug: 'consumer',
        // 'auto.commit.enable': false,
        'group.id': 'auto-commit-consumer',
      },
      topicConf: {
        'auto.offset.reset': 'earliest',
      },
    })

    for await (const incommingMessage of consumer) {
      const messages = Array.isArray(incommingMessage) ? incommingMessage : [incommingMessage]
      receivedMessages.push(...messages)
      consumer.consumer.commitMessage(messages.pop())
    }

    console.debug('DONE READING')

    expect(receivedMessages).toHaveLength(messagesToPublish)
  })

  test('consume/produce stopOnPartitionsEOF + batchMode', async () => {
    const { kafka } = service
    const topic = 'test-auto-commit-batch-eof'
    const messagesToPublish = 11

    const messageIterable = getMessageIterable(messagesToPublish)

    producer = await kafka.createProducerStream({
      streamOptions: { objectMode: true, pollInterval: 1 },
      conf: {
        'group.id': 'auto-commit-producer',
        dr_msg_cb: true,
      },
    })

    const receivedMessages: any[] = []

    // we must wait for message delivery
    // otherwise we will try to create consumer,
    // but there will be no available topic metadata in Kafka
    for await (const message of messageIterable.messagesToSend(topic)) {
      producer.write(message)
      await once(producer.producer, 'delivery-report')
    }

    consumer = await kafka.createConsumerStream({
      streamOptions: {
        topics: topic,
        streamAsBatch: true,
        fetchSize: 2,
        stopOnPartitionsEOF: true,
        offsetQueryTimeout: 10,
        objectMode: true,
      },
      conf: {
        debug: 'consumer',
        // 'auto.commit.enable': false,
        'group.id': 'auto-commit-consumer',
      },
      topicConf: {
        'auto.offset.reset': 'earliest',
      },
    })

    for await (const incommingMessage of consumer) {
      const messages = Array.isArray(incommingMessage) ? incommingMessage : [incommingMessage]
      receivedMessages.push(...messages)
      consumer.consumer.commitMessage(messages.pop())
    }

    console.debug('DONE READING')

    expect(receivedMessages).toHaveLength(messagesToPublish)
  })

  test.only('consume/produce no-auto-commit + stopOnPartitionsEOF + no BatchMode', async () => {
    const { kafka } = service
    const topic = 'test-no-auto-commit-no-batch-eof'
    const messagesToPublish = 11

    const messageIterable = getMessageIterable(messagesToPublish)

    producer = await kafka.createProducerStream({
      streamOptions: { objectMode: true, pollInterval: 1 },
      conf: {
        'group.id': 'no-commit-producer',
        dr_msg_cb: true,
      },
    })

    const receivedMessages: any[] = []

    // we must wait for message delivery
    // otherwise we will try to create consumer,
    // but there will be no available topic metadata in Kafka
    for await (const message of messageIterable.messagesToSend(topic)) {
      producer.write(message)
      await once(producer.producer, 'delivery-report')
    }

    consumer = await kafka.createConsumerStream({
      streamOptions: {
        topics: topic,
        streamAsBatch: false,
        fetchSize: 2,
        stopOnPartitionsEOF: true,
        offsetQueryTimeout: 10,
        objectMode: true,
      },
      conf: {
        debug: 'consumer',
        'auto.commit.enable': false,
        'group.id': 'no-commit-consumer-batch',
      },
      topicConf: {
        'auto.offset.reset': 'earliest',
      },
    })

    for await (const incommingMessage of consumer) {
      const messages = Array.isArray(incommingMessage) ? incommingMessage : [incommingMessage]
      receivedMessages.push(...messages)
      consumer.consumer.commitMessage(messages.pop())
    }

    console.debug('DONE READING')

    expect(receivedMessages).toHaveLength(messagesToPublish)
  })

  test('consume/produce no-auto-commit + stopOnPartitionsEOF + batchMode', async () => {
    const { kafka } = service
    const topic = 'test-no-auto-commit-batch-eof'
    const messagesToPublish = 11

    const messageIterable = getMessageIterable(messagesToPublish)

    producer = await kafka.createProducerStream({
      streamOptions: { objectMode: true, pollInterval: 1 },
      conf: {
        'group.id': 'no-commit-producer',
        dr_msg_cb: true,
      },
    })

    const receivedMessages: any[] = []

    // we must wait for message delivery
    // otherwise we will try to create consumer,
    // but there will be no available topic metadata in Kafka
    for await (const message of messageIterable.messagesToSend(topic)) {
      producer.write(message)
      await once(producer.producer, 'delivery-report')
    }

    consumer = await kafka.createConsumerStream({
      streamOptions: {
        topics: topic,
        streamAsBatch: true,
        fetchSize: 2,
        stopOnPartitionsEOF: true,
        offsetQueryTimeout: 10,
        objectMode: true,
      },
      conf: {
        debug: 'consumer',
        'auto.commit.enable': false,
        'group.id': 'no-commit-consumer-batch',
      },
      topicConf: {
        'auto.offset.reset': 'earliest',
      },
    })

    for await (const incommingMessage of consumer) {
      const messages = Array.isArray(incommingMessage) ? incommingMessage : [incommingMessage]
      receivedMessages.push(...messages)
      consumer.consumer.commitMessage(messages.pop())
    }

    console.debug('DONE READING')

    expect(receivedMessages).toHaveLength(messagesToPublish)
  })

  test('consume/produce no-auto-commit + NO stopOnPartitionsEOF NO batch', async () => {
    const { kafka } = service
    const topic = 'test-no-auto-commit'
    const messagesToPublish = 11
    const messageIterable = getMessageIterable(messagesToPublish)
    const receivedMessages: any[] = []

    producer = await kafka.createProducerStream({
      streamOptions: { objectMode: true, pollInterval: 1 },
      conf: {
        'group.id': 'no-commit-producer',
        dr_msg_cb: true,
      },
    })

    for await (const message of messageIterable.messagesToSend(topic)) {
      producer.write(message)
      await once(producer.producer, 'delivery-report')
    }

    consumer = await kafka.createConsumerStream({
      streamOptions: {
        topics: topic,
        streamAsBatch: false,
        fetchSize: 2,
        stopOnPartitionsEOF: false,
        objectMode: true,
      },
      conf: {
        debug: 'consumer',
        'auto.commit.enable': false,
        'group.id': 'no-commit-consumer',
      },
      topicConf: {
        'auto.offset.reset': 'earliest',
      },
    })

    const promise = new Promise(async () => {
      for await (const incommingMessage of consumer) {
        const messages = Array.isArray(incommingMessage) ? incommingMessage : [incommingMessage]
        receivedMessages.push(...messages)
        consumer.consumer.commitMessage(messages.pop())
      }
    }).timeout(5000)

    await expect(promise).rejects.toThrow(TimeoutError)
    expect(receivedMessages).toHaveLength(messagesToPublish)
  })
})

describe('connect error toxy', () => {
  const toxiproxy = new Toxiproxy('http://toxy:8474')

  const setProxyEnabled = async (enabled: boolean) => {
    const proxy = await toxiproxy.get('kafka-proxy')
    proxy.enabled = enabled
    await proxy.update()
  }

  beforeEach(async () => {
    await setProxyEnabled(false)
  })

  afterEach(async () => {
    await setProxyEnabled(true)
  })

  it('producer connection timeout', async () => {
    const { kafka } = service
    const createPromise = kafka.createProducerStream({
      streamOptions: { objectMode: false, topic: 'testBoo', connectOptions: { timeout: 200 } },
      conf: { 'client.id': 'consume-group-offline' },
    })
    await expect(createPromise).rejects.toThrowError(/Broker transport failure/)
  })

  it('consumer connection timeout', async () => {
    const { kafka } = service
    const createPromise = kafka.createConsumerStream({
      streamOptions: {
        topics: ['test'],
        connectOptions: { timeout: 200 },
      },
      conf: { 'client.id': 'consume-group-offline' },
    })
    await expect(createPromise).rejects.toThrowError(/Broker transport failure/)
  })
})
