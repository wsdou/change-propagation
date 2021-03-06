"use strict";


/**
 * restbase-mod-queue-kafka main entry point
 */


const P = require('bluebird');
const HyperSwitch = require('hyperswitch');
const HTTPError = HyperSwitch.HTTPError;
const uuid = require('cassandra-uuid').TimeUuid;

const utils = require('../lib/utils');
const KafkaFactory = require('../lib/kafka_factory');
const RuleSubscriber = require('../lib/rule_subscriber');

class Kafka {
    constructor(options) {
        this.options = options;
        this.kafkaFactory = new KafkaFactory(options);
        this.staticRules = options.templates || {};

        this.subscriber = new RuleSubscriber(options, this.kafkaFactory);
    }

    setup(hyper) {
        return this.kafkaFactory.createGuaranteedProducer(hyper.logger)
        .then((producer) => {
            this.producer = producer;
            HyperSwitch.lifecycle.once('close', () => {
                this.subscriber.unsubscribeAll();
                this.producer.disconnect();
            });
            return this._subscribeRules(hyper, this.staticRules);
        })
        .tap(() => hyper.logger.log('info/change-prop/init', 'Kafka Queue module initialised'));
    }

    _subscribeRules(hyper, rules) {
        return P.map(Object.keys(rules), ruleName =>
            this.subscriber.subscribe(hyper, ruleName, rules[ruleName]))
        .thenReturn({ status: 201 });
    }

    subscribe(hyper, req) {
        return this._subscribeRules(hyper, req.body);
    }

    produce(hyper, req) {
        if (this.options.test_mode) {
            hyper.logger.log('trace/produce', 'Running in TEST MODE; Production disabled');
            return { status: 201 };
        }

        const partition = req.params.partition || 0;
        const messages = req.body;
        if (!Array.isArray(messages) || !messages.length) {
            throw new HTTPError({
                status: 400,
                body: {
                    type: 'bad_request',
                    detail: 'Events should be a non-empty array'
                }
            });
        }
        // Check whether all messages contain the topic
        messages.forEach((message) => {
            const now = new Date();
            message.meta.id = message.meta.id || uuid.fromDate(now).toString();
            message.meta.dt = message.meta.dt || now.toISOString();
            message.meta.request_id = message.meta.request_id || utils.requestId();
            if (!message || !message.meta || !message.meta.topic) {
                throw new HTTPError({
                    status: 400,
                    body: {
                        type: 'bad_request',
                        detail: 'Event must have a meta.topic and meta.id properties',
                        event_str: message
                    }
                });
            }
        });
        return P.all(messages.map((message) => {
            const topicName = message.meta.topic.replace(/\./g, '_');
            hyper.metrics.increment(
                `produce_${hyper.metrics.normalizeName(topicName)}.${partition}`);

            return this.producer.produce(`${this.kafkaFactory.produceDC}.${message.meta.topic}`,
                partition,
                Buffer.from(JSON.stringify(message)));
        }))
        .thenReturn({ status: 201 });
    }
}

module.exports = (options) => {
    const kafkaMod = new Kafka(options);
    return {
        spec: {
            paths: {
                '/setup': {
                    put: {
                        summary: 'set up the kafka listener',
                        operationId: 'setup_kafka'
                    }
                },
                '/events{/partition}': {
                    post: {
                        summary: 'produces a message the kafka topic',
                        operationId: 'produce'
                    }
                },
                '/subscriptions': {
                    post: {
                        summary: 'adds a new subscription dynamically',
                        operationId: 'subscribe'
                    }
                }
            }
        },
        operations: {
            setup_kafka: kafkaMod.setup.bind(kafkaMod),
            produce: kafkaMod.produce.bind(kafkaMod),
            subscribe: kafkaMod.subscribe.bind(kafkaMod)
        },
        resources: [{
            uri: '/sys/queue/setup'
        }]
    };
};
