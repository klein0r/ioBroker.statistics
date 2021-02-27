/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

const utils        = require('@iobroker/adapter-core');
const stateObjects = require('./lib/objects');
const CronJob = require('cron').CronJob;
const adapterName  = require('./package.json').name.split('.').pop();

class Statistics extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: adapterName,
        });

        this.crons = {};
        this.typeObjects = {}; // to remember the used objects within the types (calculations)
        this.statDP = {};      // contains the complete datasets (instead of this.config)
        this.groups = {};
        this.units = {};
        this.tasks = [];
        this.states = {};      // hold all states locally

        this.column = ['15Min', 'hour', 'day', 'week', 'month', 'quarter', 'year'];
        this.copyToSave = ['count', 'sumCount', 'sumGroup', 'sumDelta'];

        this.nameObjects = {
            count: { // Count impulses or counting operations
                save: ['15Min', 'hour', 'day', 'week', 'month', 'quarter', 'year'],
                temp: ['15Min', 'hour', 'day', 'week', 'month', 'quarter', 'year', 'last5Min', 'lastPulse']
            },
            sumCount: { // Addition of analogue values (consumption from pulses) Multiplication with price = costs
                save: ['15Min', 'hour', 'day', 'week', 'month', 'quarter', 'year'],
                temp: ['15Min', 'hour', 'day', 'week', 'month', 'quarter', 'year']
            },
            sumDelta: { // Consumption from continuous quantities () Multiplication with price = costs
                save: ['15Min', 'hour', 'day', 'week', 'month', 'quarter', 'year', 'delta', 'last'],
                temp: ['15Min', 'hour', 'day', 'week', 'month', 'quarter', 'year']//, 'last5Min']
            },
            sumGroup: { // Total consumption from consecutive quantities
                save: ['15Min', 'hour', 'day', 'week', 'month', 'quarter', 'year'],
                temp: ['15Min', 'hour', 'day', 'week', 'month', 'quarter', 'year']
            },
            minmax: { // Min/Max timeframe
                save: ['dayMin', 'weekMin', 'monthMin', 'quarterMin', 'yearMin', 'dayMax', 'weekMax', 'monthMax', 'quarterMax', 'yearMax'],
                temp: ['dayMin', 'weekMin', 'monthMin', 'quarterMin', 'yearMin', 'dayMax', 'weekMax', 'monthMax', 'quarterMax', 'yearMax', 'last']
            },
            avg: { // Mean values etc.
                save: ['dayMin', 'dayMax', 'dayAvg'],
                temp: ['dayMin', 'dayMax', 'dayAvg', 'dayCount', 'daySum', 'last']
            },
            timeCount: { // Operating time counting from status change
                save: ['onDay', 'onWeek', 'onMonth', 'onQuarter', 'onYear', 'offDay', 'offWeek', 'offMonth', 'offQuarter', 'offYear'],
                temp: ['onDay', 'onWeek', 'onMonth', 'onQuarter', 'onYear', 'offDay', 'offWeek', 'offMonth', 'offQuarter', 'offYear', 'last01', 'last10', 'last']
            },
            fiveMin: { // 5 minutes, etc. only useful with impulses
                save: ['mean5Min', 'dayMax5Min', 'dayMin5Min'],
                temp: ['mean5Min', 'dayMax5Min', 'dayMin5Min']
            },
        };

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    roundValue(value, precision = 0) {
        const multiplier = Math.pow(10, precision);
        return Math.round(value * multiplier) / multiplier;
    }

    stopCrons() {
        for (const type in this.crons) {
            if (this.crons.hasOwnProperty(type) && this.crons[type]) {
                this.crons[type].stop();
                this.crons[type] = null;
            }
        }
    }

    startAdapter(options) {
        Object.assign(options, {
            // is called when adapter shuts down - callback has to be called under any circumstances!

            objectChange: (id, obj) => {
                // Warning, obj can be null if it was deleted
                // this.log.debug('received objectChange '+ id + ' obj  '+JSON.stringify(obj));
                //nur das verarbeiten was auch diesen Adapter interessiert
                if (obj && obj.common && obj.common.custom && obj.common.custom[this.namespace] && obj.common.custom[this.namespace].enabled) {
                    //hier sollte nur ein Datenpunkt angekommen sein
                    this.log.debug('received objectChange for stat' + id + ' ' + obj.common.custom);
                    // old but changhed
                    if (this.statDP[id]) {
                        //this.log.info('neu aber anderes Setting ' + id);
                        this.statDP[id] = obj.common.custom[this.namespace];
                        this.removeObject(id);
                        this.setupObjects([id], null, undefined, true);
                        this.log.debug('saved typeObjects update1 ' + JSON.stringify(this.typeObjects));
                    } else {
                        //this.log.info('ganz neu ' + id);
                        this.statDP[id] = obj.common.custom[this.namespace];
                        this.setupObjects([id]);
                        this.log.info('enabled logging of ' + id);
                        this.log.debug('saved typeObjects update2 ' + JSON.stringify(this.typeObjects));
                    }
                } else if (this.statDP[id]) {
                    //this.log.info('alt aber disabled id' + id );
                    this.unsubscribeForeignStates(id);
                    delete this.statDP[id];
                    this.log.info('disabled logging of ' + id);
                    this.removeObject(id);
                    this.log.debug('saved typeObjects update3 ' + JSON.stringify(this.typeObjects));
                }
            },
            // is called if a subscribed state changes
            stateChange: (id, state) => {
                // Warning, state can be null if it was deleted
                this.log.debug('[STATE CHANGE] ======================= ' + id + ' =======================');

                // you can use the ack flag to detect if it is status (true) or command (false)
                if (state && state.ack ) {
                    this.log.debug('[STATE CHANGE] stateChange => ' + state.val + ' [' + state.ack + ']');

                    if (!state.val && state.val !== 0) {
                        this.log.warn('[STATE CHANGE] wrong value => ' + state.val + ' on ' + id + ' => check the other adapter where value comes from ');
                    } else {
                        if (this.typeObjects.sumDelta && this.typeObjects.sumDelta.includes(id)) {
                            this.newSumDeltaValue(id, state.val);
                        } else if (this.typeObjects.avg && this.typeObjects.avg.includes(id)) {
                            this.newAvgValue(id, state.val);
                        }

                        if (this.typeObjects.minmax && this.typeObjects.minmax.includes(id)) {
                            this.newMinMaxValue(id, state.val);
                        }

                        if (this.typeObjects.count && this.typeObjects.count.includes(id)) {
                            this.newCountValue(id, state.val);
                        }

                        if (this.typeObjects.timeCount && this.typeObjects.timeCount.includes(id)) {
                            this.newTimeCntValue(id, state);
                        }
                        // 5min is treated cyclically
                    }
                }
            }
        });
    }

    removeObject(id) { // interne states[id] auch löschen?
        Object.keys(this.typeObjects).forEach(key => {
            if (this.typeObjects[key] && Array.isArray(this.typeObjects[key])) {
                const pos = this.typeObjects[key].indexOf(id);
                if (pos !== -1) {
                    this.log.debug('found ' + id + ' on pos ' + this.typeObjects[key].indexOf(id) + ' of ' + key + ' for removal');
                    this.typeObjects[key].splice(pos, 1);
                }
            } else {
                this.log.error(`Invalid structure of groups: ${JSON.stringify(this.typeObjects[key])}`);
            }
        });
        Object.keys(this.groups).forEach(g => {
            if (this.groups[g] && this.groups[g].items && Array.isArray(this.groups[g].items)) {
                const pos = this.groups[g].items.indexOf(id);
                if (pos !== -1) {
                    this.log.debug('found ' + id + ' on pos ' + this.groups[g].items.indexOf(id) + ' of ' + g + ' for removal');
                    this.groups[g].items.splice(pos, 1);
                }
            } else {
                this.log.error(`Invalid structure of groups: ${JSON.stringify(this.groups[g].items)}`);
            }
        });
    }

    // to be removed in compact? process.on('SIGINT', stop);
    timeConverter(timestamp) {
        const a = new Date(timestamp);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const year = a.getFullYear();
        const month = months[a.getMonth()];
        let date = a.getDate();
        date = date < 10 ? ' ' + date : date;
        let hour = a.getHours();
        hour = hour < 10 ? '0' + hour : hour;
        let min = a.getMinutes();
        min = min < 10 ? '0' + min : min;
        let sec = a.getSeconds();
        sec = sec < 10 ? '0' + sec : sec;
        return date + ' ' + month + ' ' + year + ' ' + hour + ':' + min + ':' + sec;
    }

    fiveMin() {
        this.log.debug('[5 MINUTES] evaluation');
        const isStart = !this.tasks.length;
        /**
         * Determine 5min values
         *
         * Get current min from temp
         * Get current max from temp
         * current value from the monitored counter
         * old value (before 5min) from the monitored counter
         *
         * determination delta and decision whether new min / max is stored
         * current counter reading is written in the old value
         *
         * typeObjects.fiveMin [t] contains the objectId of the monitored counter
         *
         */

        // go through all subscribed objects and write
        if (this.typeObjects.fiveMin) {
            for (let t = 0; t < this.typeObjects.fiveMin.length; t++) {
                this.tasks.push({
                    name: 'async',
                    args: { id: this.typeObjects.fiveMin[t] },
                    callback: (args, callback) => {
                        if (!this.statDP[args.id]) {
                            return callback && callback();
                        }
                        let temp5MinID;
                        let actualID;
                        if (this.statDP[args.id].sumDelta) {
                            temp5MinID = 'temp.sumDelta.' + args.id + '.last5Min';
                            actualID = 'save.sumDelta.' + args.id + '.last';
                        } else {
                            temp5MinID = 'temp.count.' + args.id + '.last5Min';
                            actualID = 'temp.count.' + args.id + '.day';
                        }
                        this.getValue(actualID, (err, actual) => {
                            if (actual === null) {
                                return callback();
                            }
                            this.getValue('temp.fiveMin.' + args.id + '.dayMin5Min', (err, min) => {
                                this.getValue('temp.fiveMin.' + args.id + '.dayMax5Min', (err, max) => {
                                    this.getValue(temp5MinID, (err, old) => {
                                        // Write actual state into counter object
                                        this.setValueStat(temp5MinID, actual, () => {
                                            if (old === null) {
                                                return callback();
                                            }
                                            const delta = actual - old;
                                            this.log.debug('[STATE CHANGE] fiveMin; of : ' + args.id + ' with  min: ' + min + ' max: ' + max + ' actual: ' + actual + ' old: ' + old + ' delta: ' + delta);
                                            this.setValueStat('temp.fiveMin.' + args.id + '.mean5Min', delta, () => {
                                                if (max === null || delta > max) {
                                                    this.log.debug('[STATE CHANGE] new Max ' + 'temp.fiveMin.' + args.id + '.dayMax5Min'+ ': ' + delta);
                                                    this.setValueStat('temp.fiveMin.' + args.id + '.dayMax5Min', delta, callback);
                                                    callback = null;
                                                }
                                                if (min === null || delta < min) {
                                                    this.log.debug('[STATE CHANGE] new Min ' + 'temp.fiveMin.' + args.id + '.dayMin5Min' + ': ' + delta);
                                                    this.setValueStat('temp.fiveMin.' + args.id + '.dayMin5Min', delta, callback);
                                                    callback = null;
                                                }
                                                callback && callback();
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    }
                });
            }
        }
        isStart && this.processTasks();
    }

    // cached function
    getValue(id, callback) {
        if (this.states.hasOwnProperty(id)) {
            callback(null, this.states[id]);
        } else {
            this.getForeignState(this.namespace + '.' + id, (err, value) => {
                if (value) {
                    this.states[id] = value.val;
                } else {
                    this.states[id] = null;
                }
                callback(err, this.states[id], value && value.ts);
            });
        }
    }

    // cached function
    setValueStat(id, val, callback) {
        const ts = new Date();
        ts.setMinutes(ts.getMinutes() - 1);
        ts.setSeconds(59);
        ts.setMilliseconds(0);
        this.states[id] = val;
        this.setForeignState(this.namespace + '.' + id, { val, ts: ts.getTime(), ack: true }, callback);
    }

    // cached function
    setValue(id, val, callback) {
        this.states[id] = val;
        this.setForeignState(this.namespace + '.' + id, val, true, callback);
    }

    newAvgValue(id, value) {
        const isStart = !this.tasks.length;
        /**
         * Comparison between last min / max and now transmitted value
         */
        value = parseFloat(value); // || 0; if NaN we should not put a zero inside, better to skip everything

        if (!isNaN(value)) {
            this.log.debug('[STATE CHANGE] avg call: ' + id + ' value ' + value);
            this.tasks.push({
                name: 'async',
                args: {
                    id,
                    value
                }, callback: (args, callback) => {
                    this.log.debug('[STATE CHANGE] new last for "' + 'temp.avg.' + args.id + '.last' + ': ' + value);
                    this.setValue('temp.avg.' + args.id + '.last', value); //memorize current value to have it available when date change for actual=starting point of new time frame
                    this.getValue('temp.avg.' + args.id + '.dayCount', (err, count) => {
                        count = count ? count + 1 : 1;
                        this.setValue('temp.avg.' + args.id + '.dayCount', count, () => {
                            this.getValue('temp.avg.' + args.id + '.daySum', (err, sum) => {
                                sum = sum ? sum + value : value;
                                this.setValue('temp.avg.' + args.id + '.daySum', sum, () => {
                                    this.setValue('temp.avg.' + args.id + '.dayAvg', this.roundValue(sum / count, 4), () => {
                                        this.getValue('temp.avg.' + args.id + '.dayMin', (err, tempMin) => {
                                            if (tempMin === null || tempMin > value) {
                                                this.setValue('temp.avg.' + args.id + '.dayMin', value);
                                                this.log.debug('[STATE CHANGE] new min for "' + 'temp.avg.' + args.id + '.dayMin' + ': ' + value);
                                            }
                                            this.getValue('temp.avg.' + args.id + '.dayMax', (err, tempMax) => {
                                                if (tempMax === null || tempMax < value) {
                                                    this.setValue('temp.avg.' + args.id + '.dayMax', value, callback);
                                                    this.log.debug('[STATE CHANGE] new max for "' + 'temp.avg.' + args.id + '.dayMax'+ ': ' + value);
                                                } else {
                                                    callback && callback();
                                                }
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                }
            });
            isStart && this.processTasks();
        }
    }

    newMinMaxValue(id, value) {
        const isStart = !this.tasks.length;
        /**
         * Comparison between last min / max and now transmitted value
         */
        value = parseFloat(value) || 0;
        if (!isNaN(value)) {
            this.log.debug('[STATE CHANGE] minmax call: ' + id + ' value ' + value);
            this.tasks.push({
                name: 'async',
                args: {
                    id,
                    value
                }, callback: (args, callback) => {
                    this.log.debug('[STATE CHANGE] new last for "' + 'temp.minmax.' + args.id + '.last' + ': ' + value);
                    this.setValue('temp.minmax.' + args.id + '.last', value); //memorize current value to have it available when date change for actual=starting point of new time frame
                    this.getValue('temp.minmax.' + args.id + '.yearMin', (err, tempMin) => {
                        if (tempMin === null || tempMin > value) {
                            this.setValue('temp.minmax.' + args.id + '.yearMin', value);
                            this.log.debug('[STATE CHANGE] new year min for "' + args.id + ': ' + value);
                        }
                        this.getValue('temp.minmax.' + args.id + '.yearMax', (err, tempMax) => {
                            if (tempMax === null || tempMax < value) {
                                this.setValue('temp.minmax.' + args.id + '.yearMax', value);
                                this.log.debug('[STATE CHANGE] new year max for "' + args.id + ': ' + value);
                            }
                            this.getValue('temp.minmax.' + args.id + '.quarterMin', (err, tempMin) => {
                                if (tempMin === null || tempMin > value) {
                                    this.setValue('temp.minmax.' + args.id + '.quarterMin', value);
                                    this.log.debug('[STATE CHANGE] new quarter min for "' + args.id + ': ' + value);
                                }
                                this.getValue('temp.minmax.' + args.id + '.quarterMax', (err, tempMax) => {
                                    if (tempMax === null || tempMax < value) {
                                        this.setValue('temp.minmax.' + args.id + '.quarterMax', value);
                                        this.log.debug('[STATE CHANGE] new quarter max for "' + args.id + ': ' + value);
                                    }
                                    this.getValue('temp.minmax.' + args.id + '.monthMin', (err, tempMin) => {
                                        if (tempMin === null || tempMin > value) {
                                            this.setValue('temp.minmax.' + args.id + '.monthMin', value);
                                            this.log.debug('[STATE CHANGE] new month min for "' + args.id + ': ' + value);
                                        }
                                        this.getValue('temp.minmax.' + args.id + '.monthMax', (err, tempMax) => {
                                            if (tempMax === null || tempMax < value) {
                                                this.setValue('temp.minmax.' + args.id + '.monthMax', value);
                                                this.log.debug('[STATE CHANGE] new month max for "' + args.id + ': ' + value);
                                            }
                                            this.getValue('temp.minmax.' + args.id + '.weekMin', (err, tempMin) => {
                                                if (tempMin === null || tempMin > value) {
                                                    this.setValue('temp.minmax.' + args.id + '.weekMin', value);
                                                    this.log.debug('[STATE CHANGE] new week min for "' + args.id + ': ' + value);
                                                }
                                                this.getValue('temp.minmax.' + args.id + '.weekMax', (err, tempMax) => {
                                                    if (tempMax === null || tempMax < value) {
                                                        this.setValue('temp.minmax.' + args.id + '.weekMax', value);
                                                        this.log.debug('[STATE CHANGE] new week max for "' + args.id + ': ' + value);
                                                    }
                                                    this.getValue('temp.minmax.' + args.id + '.dayMin', (err, tempMin) => {
                                                        if (tempMin === null || tempMin > value) {
                                                            this.setValue('temp.minmax.' + args.id + '.dayMin', value);
                                                            this.log.debug('[STATE CHANGE] new day min for "' + args.id + ': ' + value);
                                                        }
                                                        this.getValue('temp.minmax.' + args.id + '.dayMax', (err, tempMax) => {
                                                            if (tempMax === null || tempMax < value) {
                                                                this.setValue('temp.minmax.' + args.id + '.dayMax', value, callback);
                                                                this.log.debug('[STATE CHANGE] new day max for "' + args.id + ': ' + value);
                                                            } else {
                                                                callback && callback();
                                                            }
                                                        });
                                                    });
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                }
            });
            isStart && this.processTasks();
        }
    }

    newCountValue(id, value) {
        const isStart = !this.tasks.length;
        /*
            value with limit or state
            Change to 1 -> increase by 1
            Value greater threshold -> increase by 1
        */
        this.log.debug('[STATE CHANGE] count call ' + id + ' with ' + value);
        // nicht nur auf true/false prüfen, es muß sich um eine echte Flanke handeln
        // derzeitigen Zustand mit prüfen, sonst werden subscribed status updates mitgezählt
        if (this.isTrueNew(id, value)) {
            this.tasks.push({
                name: 'async',
                args: { id },
                callback: (args, callback) => {
                    if (!this.statDP[args.id]) {
                        return callback && callback();
                    }

                    for (let s = 0; s < this.nameObjects.count.temp.length; s++) {
                        if (this.nameObjects.count.temp[s] !== 'lastPulse') {
                            this.tasks.push({
                                name: 'async',
                                args: {
                                    id: 'temp.count.' + id + '.' + this.nameObjects.count.temp[s]
                                },
                                callback: (args, callback) => {
                                    this.getValue(args.id, (err, oldVal) => {
                                        oldVal = oldVal ? oldVal + 1 : 1;
                                        this.log.debug('[STATE CHANGE] Increase ' + args.id + ' on 1 to ' + oldVal);
                                        this.setValue(args.id, oldVal, callback);
                                    });
                                }
                            });
                            // Calculation of consumption (what is a physical-sized pulse)
                            if (this.typeObjects.sumCount &&
                                this.typeObjects.sumCount.indexOf(args.id) !== -1 &&
                                this.statDP[args.id].impUnitPerImpulse) { // counter mit Verbrauch
                                this.tasks.push({
                                    name: 'async',
                                    args: {
                                        id: 'temp.sumCount.' + args.id + '.' + this.nameObjects.count.temp[s],
                                        impUnitPerImpulse: this.statDP[args.id].impUnitPerImpulse
                                    },
                                    callback: (args, callback) => {
                                        this.getValue(args.id, (err, consumption) => {
                                            const value = consumption ? consumption + args.impUnitPerImpulse : args.impUnitPerImpulse;
                                            this.log.debug('[STATE CHANGE] Increase ' + args.id + ' on ' + args.impUnitPerImpulse + ' to ' + value);
                                            this.setValue(args.id, value, callback);
                                        });
                                    }
                                });
                                // add consumption to group
                                if (this.statDP[args.id].sumGroup &&
                                    this.groups[this.statDP[args.id].sumGroup] &&
                                    this.groups[this.statDP[args.id].sumGroup].config &&
                                    this.statDP[args.id].impUnitPerImpulse &&
                                    this.statDP[args.id].groupFactor
                                ) {
                                    const factor = this.statDP[args.id].groupFactor;
                                    const price = this.groups[this.statDP[args.id].sumGroup].config.price;
                                    for (let i = 0; i < this.nameObjects.sumGroup.temp.length; i++) {
                                        this.tasks.push({
                                            name: 'async',
                                            args: {
                                                delta: this.statDP[args.id].impUnitPerImpulse * factor * price,
                                                id: 'temp.sumGroup.' + this.statDP[args.id].sumGroup + '.' + this.nameObjects.sumGroup.temp[i],
                                                type: this.nameObjects.sumGroup.temp[i]
                                            },
                                            callback: (args, callback) =>
                                                this.getValue(args.id, (err, value, ts) => {
                                                    if (ts) {
                                                        value = this.checkValue(value || 0, ts, args.id, args.type);
                                                    }
                                                    // value auf 4 stellen hinter dem Komma festgelegt
                                                    value = this.roundValue(((value || 0) + args.delta), 4);
                                                    this.log.debug('[STATE CHANGE] Increase ' + args.id + ' on ' + args.delta + ' to ' + value);
                                                    this.setValue(args.id, value, callback);
                                                })
                                        });
                                    }
                                }
                            }
                        }
                    }
                    callback();
                }
            });
        }
        isStart && this.processTasks();
    }

    checkValue(value, ts, id, type) {
        const now = new Date();
        now.setSeconds(0);
        now.setMilliseconds(0);
        if (type === '15Min') {
            // value may not be older than 15 min
            now.setMinutes(now.getMinutes() - now.getMinutes() % 15);
        } else
        if (type === 'hour') {
            // value may not be older than full hour
            now.setMinutes(0);
        } else
        if (type === 'day') {
            // value may not be older than 00:00 of today
            now.setMinutes(0);
            now.setHours(0);
        } else
        if (type === 'week') {
            // value may not be older than 00:00 of today
            now.setMinutes(0);
            now.setHours(0);
        } else
        if (type === 'month') {
            // value may not be older than 00:00 of today
            now.setMinutes(0);
            now.setHours(0);
            now.setDate(1);
        } else
        if (type === 'quarter') {
            // value may not be older than 00:00 of today
            now.setMinutes(0);
            now.setHours(0);
            now.setDate(1);
            //0, 3, 6, 9
            now.setMonth(now.getMonth() - now.getMonth() % 3);
        } else
        if (type === 'year') {
            // value may not be older than 1 Januar of today
            now.setMinutes(0);
            now.setHours(0);
            now.setDate(1);
            now.setMonth(0);
        } else {
            this.log.error('Unknown calc type: ' + type);
            return value;
        }
        if (ts < now.getTime()) {
            this.log.warn('[STATE CHANGE] Value of ' + id + ' ignored because older than ' + now.toISOString());
            value = 0;
        }
        return value;
    }

    newSumDeltaValue(id, value) {
        const isStart = !this.tasks.length;
        /*
            determine the consumption per period as consecutive meter readings.
                 - Validity check new value must be greater than age
                 - Subtraction with last value Day
                 - Subtraction with last value today -> delta for sum
                 - Add delta to all values
                 - treat own values differently (datapoint name)
        */
        value = parseFloat(value) || 0; //here we can probably leave the 0, if undefined then we have 0
        this.tasks.push({
            name: 'async',
            args: { id },
            callback: (args, callback) => {
                this.getValue('save.sumDelta.' + args.id + '.last', (err, old) => {
                    if (!this.statDP[args.id]) {
                        return callback && callback();
                    }

                    this.tasks.push({
                        name: 'async',
                        args: { id: 'save.sumDelta.' + args.id + '.last', value },
                        callback: (args, callback) => this.setValue(args.id, args.value, callback)
                    });
                    if (old === null) {
                        return callback();
                    }
                    let delta = value - old;
                    if (delta < 0) {
                        if (this.statDP[args.id].sumIgnoreMinus) {
                            delta = 0;
                        } else {
                            // Counter overflow!
                            delta = value; // Difference between last value and overflow is error rate
                        }
                    }
                    // delta auf 4 stellen hinter dem Komma begrenzen
                    delta = this.roundValue(delta, 4);
                    this.tasks.push({
                        name: 'async',
                        args: {
                            delta,
                            id: 'save.sumDelta.' + args.id + '.delta'
                        },
                        callback: (args, callback) => this.setValue(args.id, args.delta, callback)
                    });

                    for (let i = 0; i < this.nameObjects.sumDelta.temp.length; i++) {
                        this.tasks.push({
                            name: 'async',
                            args: {
                                delta,
                                id: 'temp.sumDelta.' + args.id + '.' + this.nameObjects.sumDelta.temp[i],
                                type: this.nameObjects.sumDelta.temp[i]
                            },
                            callback: (args, callback) =>
                                this.getValue(args.id, (err, value, ts) => {
                                    // Check if the value not older than interval
                                    if (ts) {
                                        value = this.checkValue(value, ts, args.id, args.type);
                                    }
                                    // value auf 4 stellen hinter dem Komma begrenzen
                                    value = this.roundValue((value || 0) + args.delta, 4);
                                    this.log.debug('[STATE CHANGE] Increase ' + args.id + ' on ' + args.delta + ' to ' + value);
                                    this.setValue(args.id, value, callback);
                                })
                        });
                    }
                    // calculate average
                    if (this.typeObjects.avg && this.typeObjects.avg.indexOf(args.id)) {
                        this.newAvgValue(args.id, delta);
                    }
                    if (this.statDP[args.id].sumGroup &&
                        this.groups[this.statDP[args.id].sumGroup] &&
                        this.statDP[args.id].groupFactor
                    ) {
                        const factor = this.statDP[args.id].groupFactor;
                        const price = this.groups[this.statDP[args.id].sumGroup].config.price;
                        for (let i = 0; i < this.nameObjects.sumGroup.temp.length; i++) {
                            this.tasks.push({
                                name: 'async',
                                args: {
                                    delta: delta * factor * price,
                                    id: 'temp.sumGroup.' + this.statDP[args.id].sumGroup + '.' + this.nameObjects.sumGroup.temp[i],
                                    type: this.nameObjects.sumGroup.temp[i]
                                },
                                callback: (args, callback) =>
                                    this.getValue(args.id, (err, value, ts) => {
                                        // Check if the value not older than interval
                                        if (ts) {
                                            value = this.checkValue(value || 0, ts, args.id, args.type);
                                        }
                                        // value auf 4 stellen hinter dem Komma festgelegt
                                        value = this.roundValue((value || 0) + args.delta, 4);
                                        this.log.debug('[STATE CHANGE] Increase ' + args.id + ' on ' + args.delta + ' to ' + value);
                                        this.setValue(args.id, value, callback);
                                    })
                            });
                        }
                    }
                    callback();
                });
            }
        });
        isStart && this.processTasks();
    }

    isTrueNew(id, val) { //detection if a count value is real or only from polling with same state
        let newPulse = false;
        this.getValue('temp.count.' + id + '.lastPulse', (err, value) => {
            this.setValue('temp.count.' + id + '.lastPulse', val);
            if (value === val) {
                newPulse = false;
                this.log.debug('new pulse false ? ' + newPulse);
            } else {
                newPulse = this.isTrue(val);
                this.log.debug('new pulse true ? ' + newPulse);
            }
        });
        return newPulse;
    }

    isTrue(val) {
        return val === 1 || val === '1' || val === true || val === 'true' || val === 'on' || val === 'ON';
    }

    isFalse(val) {
        return val === 0 || val === '0' || val === false || val === 'false' || val === 'off' || val === 'OFF' || val === 'standby';
    }

    newTimeCntValue(id, state) {
        const isStart = !this.tasks.length;
        /*
        value with threshold or state
        Change to 1 at threshold 0 -> time between event since last 0
        Addition of time
        Change to 0 at threshold 1 -> time between event since last 1
        Addition of time
        no change but retrigger counts up the time of respective state
        */
        this.log.debug('[STATE CHANGE] timecount call ' + id + ' with ' + state.val); // !! val ist hier falsch da state komplett übergeben
        if (this.isTrue(state.val)) {
            this.tasks.push({
                name: 'async',
                args: {
                    id,
                    state
                },
                callback: (args, callback) => {
                    this.getValue('temp.timeCount.' + args.id + '.last', (err, actual) => { //Bestimmung letzter Zustand, wegen mehrfach gleicher Wert
                        if (!this.isTrue(actual)) { // ein echter Signalwechsel, somit Bestimmung delta für OFF-Zeitraum von 1->0 bis jetzt 0->1
                            this.getValue('temp.timeCount.' + args.id + '.last10', (err, last) => {
                                let delta = last ? state.ts - last : 0; // wenn last true dann delta, ansonsten 0
                                if (delta < 0) {
                                    delta = 0;
                                } else {
                                    delta = Math.floor(delta / 1000);
                                }
                                this.log.debug('[STATE CHANGE] new last ' + 'temp.timeCount.' + args.id + '.last' + ': ' + state.val);
                                this.setValue('temp.timeCount.' + args.id + '.last', state.val, () => { //setzen des last-Werte auf derzeitig verarbeiteten Wert
                                    this.log.debug('[STATE CHANGE] new last01 ' + 'temp.timeCount.' + args.id + '.last01' + ': ' + state.ts + '  ' + this.timeConverter(state.ts) );
                                    this.setValue('temp.timeCount.' + args.id + '.last01', state.ts, () => {
                                        this.log.debug('[STATE CHANGE] 0->1 delta ' + delta + ' state ' + this.timeConverter(state.ts) + ' last ' + this.timeConverter(last));
                                        for (let s = 0; s < this.nameObjects.timeCount.temp.length; s++) { // über alle Zeiträume den Wert aufaddieren
                                            if (this.nameObjects.timeCount.temp[s].match(/off\w+$/)) {
                                                this.tasks.push({
                                                    name: 'async',
                                                    args: {
                                                        id: 'temp.timeCount.' + args.id + '.' + this.nameObjects.timeCount.temp[s]
                                                    },
                                                    callback: (args, callback) => {
                                                        this.getValue(args.id, (err, time) => {
                                                            this.log.debug('[STATE CHANGE] 0->1 new val ' + args.id + ': ' + ((time || 0) + delta));
                                                            this.setValue(args.id, (time || 0) + delta, callback);
                                                        });
                                                    }
                                                });
                                            }
                                        }
                                        callback();
                                    });
                                });
                            });
                        }
                        else { // kein Signalwechsel, nochmal gleicher Zustand, somit Bestimmung delta für update ON-Zeitraum von letzten 0->1 bis jetzt 0->1
                            this.getValue('temp.timeCount.' + args.id + '.last01', (err, last) => {
                                let delta = last ? state.ts - last : 0; // wenn last true dann delta, ansonsten 0
                                if (delta < 0) {
                                    delta = 0;
                                } else {
                                    delta = Math.floor(delta / 1000);
                                }
                                this.log.debug('[STATE CHANGE] new last ' + 'temp.timeCount.' + args.id + '.last' + ': ' + state.val);
                                this.setValue('temp.timeCount.' + args.id + '.last', state.val, () => { //setzen des last-Werte auf derzeitig verarbeiteten Wert
                                    this.log.debug('[STATE CHANGE] new last01 ' + 'temp.timeCount.' + args.id + '.last01' + ': ' + state.ts + '  ' + this.timeConverter(state.ts));
                                    this.setValue('temp.timeCount.' + args.id + '.last01', state.ts, () => {
                                        this.log.debug('[STATE EQUAL] 1->1 delta ' + delta + ' state ' + this.timeConverter(state.ts) + ' last ' + this.timeConverter(last));
                                        for (let s = 0; s < this.nameObjects.timeCount.temp.length; s++) { // über alle Zeiträume den Wert aufaddieren
                                            if (this.nameObjects.timeCount.temp[s].match(/^on\w+$/)) { // ^ wegen on in Month
                                                this.tasks.push({
                                                    name: 'async',
                                                    args: {
                                                        id: 'temp.timeCount.' + args.id + '.' + this.nameObjects.timeCount.temp[s]
                                                    },
                                                    callback: (args, callback) => {
                                                        this.getValue(args.id, (err, time) => {
                                                            this.log.debug('[STATE EQUAL] 1->1 new val ' + args.id + ': ' + ((time || 0) + delta));
                                                            this.setValue(args.id, (time || 0) + delta, callback);
                                                        });
                                                    }
                                                });
                                            }
                                        }
                                        callback();
                                    });
                                });
                            });
                        }
                    });
                }
            });
        } else if (this.isFalse(state.val)) {
            this.tasks.push({
                name: 'async',
                args: {
                    id,
                    state
                },
                callback: (args, callback) => {
                    this.getValue('temp.timeCount.' + args.id + '.last', (err, actual) => { //Bestimmung letzter Zustand, wegen mehrfach gleicher Wert
                        if (this.isTrue(actual)) { // ein echter Signalwechsel, somit Bestimmung delta für ON-Zeitraum von 0->1 bis jetzt 1->0
                            this.getValue('temp.timeCount.' + args.id + '.last01', (err, last) => {
                                let delta = last ? state.ts - last : 0;
                                if (delta < 0) {
                                    delta = 0;
                                } else {
                                    delta = Math.floor(delta / 1000);
                                }
                                this.log.debug('[STATE CHANGE] new last ' + 'temp.timeCount.' + args.id + '.last' + ': ' + state.val);
                                this.setValue('temp.timeCount.' + args.id + '.last', state.val, () => { //setzen des last-Werte auf derzeitig verarbeiteten Wert
                                    this.log.debug('[STATE CHANGE] new last10 ' + 'temp.timeCount.' + args.id + '.last10' + ': ' + state.ts + '  ' + this.timeConverter(state.ts));
                                    this.setValue('temp.timeCount.' + args.id + '.last10', state.ts, () => {
                                        this.log.debug('[STATE CHANGE] 1->0 delta ' + delta + ' state ' + this.timeConverter(state.ts) + ' last ' + this.timeConverter(last));
                                        for (let s = 0; s < this.nameObjects.timeCount.temp.length; s++) {
                                            if (this.nameObjects.timeCount.temp[s].match(/^on\w+$/)) { // on auch in Month drin, deswegen ^
                                                this.tasks.push({
                                                    name: 'async',
                                                    args: {
                                                        id: 'temp.timeCount.' + args.id + '.' + this.nameObjects.timeCount.temp[s]
                                                    },
                                                    callback: (args, callback) => {
                                                        this.getValue(args.id, (err, time) => {
                                                            this.log.debug('[STATE CHANGE] 1->0 new val ' + args.id + ': ' + ((time || 0) + delta));
                                                            this.setValue(args.id, (time || 0) + delta, callback);
                                                        });
                                                    }
                                                });
                                            }
                                        }
                                        callback();
                                    });
                                });
                            });
                        }
                        else { // kein Signalwechsel, nochmal gleicher Zustand, somit Bestimmung delta für update OFF-Zeitraum von letzten 1->0 bis jetzt 1->0
                            this.getValue('temp.timeCount.' + args.id + '.last10', (err, last) => {
                                let delta = last ? state.ts - last : 0;
                                if (delta < 0) {
                                    delta = 0;
                                } else {
                                    delta = Math.floor(delta / 1000);
                                }
                                this.log.debug('[STATE CHANGE] new last ' + 'temp.timeCount.' + args.id + '.last' + ': ' + state.val);
                                this.setValue('temp.timeCount.' + args.id + '.last', state.val, () => { //setzen des last-Werte auf derzeitig verarbeiteten Wert
                                    this.log.debug('[STATE CHANGE] new last10 ' + 'temp.timeCount.' + args.id + '.last10' + ': ' + state.ts + '  ' + this.timeConverter(state.ts) );
                                    this.setValue('temp.timeCount.' + args.id + '.last10', state.ts, () => {
                                        this.log.debug('[STATE EQUAL] 0->0 delta ' + delta + ' state ' + this.timeConverter(state.ts) + ' last ' + this.timeConverter(last));
                                        for (let s = 0; s < this.nameObjects.timeCount.temp.length; s++) {
                                            if (this.nameObjects.timeCount.temp[s].match(/off\w+$/)) {
                                                this.tasks.push({
                                                    name: 'async',
                                                    args: {
                                                        id: 'temp.timeCount.' + args.id + '.' + this.nameObjects.timeCount.temp[s]
                                                    },
                                                    callback: (args, callback) => {
                                                        this.getValue(args.id, (err, time) => {
                                                            this.log.debug('[STATE EQUAL] 0->0 new val ' + args.id + ': ' + ((time || 0) + delta));
                                                            this.setValue(args.id, (time || 0) + delta, callback);
                                                        });
                                                    }
                                                });
                                            }
                                        }
                                        callback();
                                    });
                                });
                            });
                        }
                    });
                }
            });
        }
        isStart && this.processTasks();
    }
    // normales Umspeichern, temp wird auf 0 gesetzt!!
    copyValue(args, callback) {
        this.getValue(args.temp, (err, value) => {
            if (value !== null && value !== undefined) {
                this.log.debug('[SAVE VALUES] Process ' + args.temp + ' = ' + value);
                value = value || 0; // protect against NaN
                this.setValueStat(args.save, value, () =>
                    this.setValue(args.temp, 0, callback));
            } else {
                this.log.debug('[SAVE VALUES] Process ' + args.temp + ' => no value found');
                callback && callback();
            }
        });
    }

    // Setzen der Ausgangspunkte für Min/Maxmit aktuelle Wert, anstatt mit 0
    copyValueActMinMax(args, callback) {
        this.getValue(args.temp, (err, value) => {
            if (value !== null && value !== undefined) {
                this.log.debug('[SAVE VALUES] Process ' + args.temp + ' = ' + value + ' to ' +args.save);
                value = value || 0; // protect against NaN
                this.setValueStat(args.save, value, () =>
                    this.getValue(args.actual, (err, actual) => {
                        this.log.debug('[SET DAILY START MINMAX] Process ' + args.temp + ' = ' + actual + ' from ' + args.actual);
                        this.setValue(args.temp, actual, callback);
                    }));
            } else {
                this.log.debug('[SAVE VALUES & SET DAILY START MINMAX] Process ' + args.temp + ' => no value found');
                callback && callback();
            }
        });
    }

    // für gruppenwerte
    copyValueRound(args, callback) {
        this.getValue(args.temp, (err, value) => {
            if (value !== null && value !== undefined) {
                this.log.debug('[SAVE VALUES] Process ' + args.temp + ' = ' + value + ' to ' + args.save);
                this.setValueStat(args.save, this.roundValue(value, 4), () =>
                    this.setValue(args.temp, 0, callback));
            } else {
                this.log.debug('[SAVE VALUES] Process ' + args.temp + ' => no value found');
                callback && callback();
            }
        });
    }

    // avg Werte umspeichern und auf 0 setzen
    copyValue0(args, callback) {
        this.getValue(args.temp, (err, value) => {
            value = value || 0;
            this.log.debug('[SAVE VALUES] Process ' + args.temp + ' = ' + value + ' to ' + args.save);
            this.setValueStat(args.save, value, () =>
                this.setValue(args.temp, 0, callback));
        });
    }

    // Betriebszeitzählung umspeichern und temp Werte auf 0 setzen
    copyValue1000(args, callback) {
        this.getValue(args.temp, (err, value) => {
            //value = Math.floor((value || 0) / 1000);
            this.log.debug('[SAVE VALUES] Process ' + args.temp + ' = ' + value + ' to ' + args.save);
            this.setValueStat(args.save, value, () =>
                this.setValue(args.temp, 0, callback));
        });
    }

    setTimeCountMidnight() {
        if (this.typeObjects.timeCount) {
            for (let s = 0; s < this.typeObjects.timeCount.length; s++) {
                const id = this.typeObjects.timeCount[s];
                // bevor umgespeichert wird, muß noch ein Aufruf mit actual erfolgen, damit die restliche Zeit vom letzten Signalwechsel bis Mitternacht erfolgt
                // aufruf von newTimeCntValue(id, "last") damit wird gleicher Zustand getriggert und last01 oder last10 zu Mitternacht neu gesetzt
                this.getForeignState(this.namespace + '.temp.timeCount.' + id + '.last', (err, last) => { //hier muss nur id stehen, dann aber noch Beachtung des Timestamps
                    //evtl. status ermitteln und dann setForeignState nochmals den Zustand schreiben um anzutriggern und aktuelle Zeit zu verwenden (bzw. 00:00:00)
                    const ts = new Date();
                    //ts.setMinutes(ts.getMinutes() - 1);
                    //ts.setSeconds(59);
                    //ts.setMilliseconds(0);
                    if (last) {
                        last.ts = ts.getTime();
                        this.newTimeCntValue(id, last);
                    }
                });
            }
        }
    }

    // Store values to "save" for specific period
    saveValues(timePeriod) {
        const isStart = !this.tasks.length;
        const dayTypes = [];
        for (const key in this.typeObjects) {
            if (this.typeObjects.hasOwnProperty(key) &&
                this.typeObjects[key] &&
                this.typeObjects[key].length &&
                this.copyToSave.indexOf(key) !== -1
            ) {
                dayTypes.push(key);
            }
        }
        const day = this.column.indexOf(timePeriod);  // nameObjects[day] contains the time-related object value
        // all values
        this.log.debug('[SAVE VALUES] saving ' + timePeriod + ' values');

        // Schleife für alle Werte die durch day-variable bestimmt sind, gilt durch copyToSave für 'count', 'sumCount', 'sumGroup', 'sumDelta'
        // avg, timeCount /fivemin braucht extra Behandlung
        for (let t = 0; t < dayTypes.length; t++) {
            for (let s = 0; s < this.typeObjects[dayTypes[t]].length; s++) {
                // ignore last5min
                if (this.nameObjects[dayTypes[t]].temp[day] === 'last5Min') continue;
                const id = this.typeObjects[dayTypes[t]][s];
                this.tasks.push({
                    name: 'async',
                    args: {
                        temp: 'temp.' + dayTypes[t] + '.' + id + '.' + this.nameObjects[dayTypes[t]].temp[day],
                        save: 'save.' + dayTypes[t] + '.' + id + '.' + this.nameObjects[dayTypes[t]].temp[day]
                    },
                    callback: dayTypes[t] === 'sumGroup' ? this.copyValueRound : this.copyValue
                });
            }
        }

        // avg values sind nur Tageswerte, also nur bei 'day' auszuwerten
        // Setzen auf den aktuellen Wert fehlt noch irgendwie ? jetz copyValueActMinMAx
        if (timePeriod === 'day' && this.typeObjects.avg) {
            for (let s = 0; s < this.typeObjects.avg.length; s++) {
                const id = this.typeObjects.avg[s];
                this.tasks.push({
                    name: 'async',
                    args: {
                        temp: 'temp.avg.' + id + '.dayMin',
                        save: 'save.avg.' + id + '.dayMin',
                        actual: 'temp.avg.' + id + '.last',
                    },
                    callback: this.copyValueActMinMax
                });
                this.tasks.push({
                    name: 'async',
                    args: {
                        temp: 'temp.avg.' + id + '.dayMax',
                        save: 'save.avg.' + id + '.dayMax',
                        actual: 'temp.avg.' + id + '.last',
                    },
                    callback: this.copyValueActMinMax
                });
                this.tasks.push({
                    name: 'async',
                    args: {
                        temp: 'temp.avg.' + id + '.dayAvg',
                        save: 'save.avg.' + id + '.dayAvg',
                    },
                    callback: this.copyValue0
                });
                // just reset the counter
                this.tasks.push({
                    name: 'async',
                    args: {
                        temp: 'temp.avg.' + id + '.dayCount'
                    },
                    callback: (args, callback) => this.setValueStat(args.temp, 0, callback)
                });
                // just reset the counter
                this.tasks.push({
                    name: 'async',
                    args: {
                        temp: 'temp.avg.' + id + '.daySum'
                    },
                    callback: (args, callback) => this.setValueStat(args.temp, 0, callback)
                });
            }
        }

        // saving the dayly fiveMin max/min
        // Setzen auf den aktuellen Wert fehlt noch irgendwie ?
        if (timePeriod === 'day' && this.typeObjects.fiveMin) {
            for (let s = 0; s < this.typeObjects.fiveMin.length; s++) {
                const id = this.typeObjects.fiveMin[s];
                this.tasks.push({
                    name: 'async',
                    args: {
                        temp: 'temp.fiveMin.' + id + '.dayMin5Min',
                        save: 'save.fiveMin.' + id + '.dayMin5Min'
                    },
                    callback: this.copyValue
                });
                this.tasks.push({
                    name: 'async',
                    args: {
                        temp: 'temp.fiveMin.' + id + '.dayMax5Min',
                        save: 'save.fiveMin.' + id + '.dayMax5Min'
                    },
                    callback: this.copyValue
                });
            }
        }

        // timeCount hat andere Objektbezeichnungen und deswegen kann day aus timeperiod nicht benutzt werden
        // day erst ab 2ter Stelle im Array (ohne 15min und hour soll benutzt werden) -> also (day > 1) und [day-2]
        if (day > 1) {
            if (this.typeObjects.timeCount) {
                for (let s = 0; s < this.typeObjects.timeCount.length; s++) {
                    const id = this.typeObjects.timeCount[s];
                    this.tasks.push({
                        name: 'async',
                        args: {
                            temp: 'temp.timeCount.' + id + '.' + this.nameObjects.timeCount.temp[day - 2], // 0 ist onDay
                            save: 'save.timeCount.' + id + '.' + this.nameObjects.timeCount.temp[day - 2],
                        },
                        callback: this.copyValue1000
                    });
                    this.tasks.push({
                        name: 'async',
                        args: {
                            temp: 'temp.timeCount.' + id + '.' + this.nameObjects.timeCount.temp[day + 3], // +5 ist offDay
                            save: 'save.timeCount.' + id + '.' + this.nameObjects.timeCount.temp[day + 3],
                        },
                        callback: this.copyValue1000
                    });
                }
            }
        }
        // minmax hat andere Objektbezeichnungen und deswegen kann day aus timeperiod nicht benutzt werden
        // day erst ab 2ter Stelle im Array (ohne 15min und hour soll benutzt werden) -> also (day > 1) und [day-2]
        if (day > 1) { //bezieht sich auf column array
            if (this.typeObjects.minmax) {
                for (let s = 0; s < this.typeObjects.minmax.length; s++) {
                    const id = this.typeObjects.minmax[s];
                    this.tasks.push({
                        name: 'async',
                        args: {
                            temp: 'temp.minmax.' + id + '.' + this.nameObjects.minmax.temp[day - 2], // 0 ist minDay
                            save: 'save.minmax.' + id + '.' + this.nameObjects.minmax.temp[day - 2],
                            actual: 'temp.minmax.' + id + '.last',
                        },
                        callback: this.copyValueActMinMax
                    });
                    this.tasks.push({
                        name: 'async',
                        args: {
                            temp: 'temp.minmax.' + id + '.' + this.nameObjects.minmax.temp[day + 3], // +5 ist maxDay
                            save: 'save.minmax.' + id + '.' + this.nameObjects.minmax.temp[day + 3],
                            actual: 'temp.minmax.' + id + '.last',
                        },
                        callback: this.copyValueActMinMax
                    });
                }
            }
        }
        isStart && this.processTasks();
    }

    setInitial(type, id) {
        // if values have not already been logged from the last adapter start,
        // then fill them with '0' so that the read does not hit the values undefined.
        const nameObjectType = this.nameObjects[type];
        const objects = nameObjectType.temp;
        const isStart = !this.tasks.length;
        for (let s = 0; s < objects.length; s++) {
            this.tasks.push({
                name: 'async',
                args: {
                    name: objects[s],
                    id: 'temp.' + type + '.' + id + '.' + objects[s],
                    trueId: id,
                    type
                },
                wait: true,
                callback: (args, callback) => {
                    this.log.debug('[SET INITIAL] ' + args.trueId + ' ' + args.type + ' ' + args.name);
                    this.getValue(args.id, (err, value) => {
                        this.log.debug('[SET INITIAL] ' + args.trueId + ' value ' + args.id + ' exists ?  ' + value + ' in obj: ' + args.id);
                        if (value === null) {
                            this.log.debug('[SET INITIAL] ' + args.trueId + ' replace with 0 -> ' + args.id);
                            if (args.type === 'avg') {
                                if (args.name === 'dayCount') {
                                    this.getForeignState(args.trueId, (er, value) => {
                                        if (value && value.val !== null) {
                                            this.setValue(args.id, 1, callback);
                                        } else {
                                            callback();
                                        }
                                    });
                                } else {
                                    this.getForeignState(args.trueId, (er, value) => { // get current value to set for initial min, max, last
                                        if (value && value.val !== null) {
                                            this.log.debug('[SET INITIAL] ' + args.trueId + ' object ' + args.trueId + ' ' + args.name);
                                            this.log.debug('[SET INITIAL] ' + args.trueId + ' act value ' + value.val);
                                            this.setValue(args.id, value.val, callback);
                                        } else {
                                            callback();
                                        }
                                    });
                                }
                            } else if (args.type === 'minmax') {
                                this.getForeignState(args.trueId, (er, value) => { // get current value to set for initial min, max, last
                                    if (value && value.val !== null) {
                                        this.log.debug('[SET INITIAL] ' + args.trueId + ' object ' + args.trueId + ' ' + args.name);
                                        this.log.debug('[SET INITIAL] ' + args.trueId + ' act value ' + value.val);
                                        this.setValue(args.id, value.val, callback);
                                    } else {
                                        callback();
                                    }
                                });
                            } else {
                                if (args.name === 'last01') {
                                    this.getForeignState(args.trueId, (err, state) => { // get current value
                                        this.log.debug('[SET INITIAL] ' + args.trueId + ' object ' + args.trueId + ' ' + args.name);
                                        this.log.debug('[SET INITIAL] ' + args.trueId + ' act value ' + (state && state.val) + ' time ' + (state && state.lc));
                                        if (this.isFalse(state && state.val)) {
                                            this.log.debug('[SET INITIAL] ' + args.trueId + ' state is false und last 01 now as lastChange');
                                            this.setValue(args.id, Date.now(), callback);
                                            this.setValue(args.id, Date.now(), callback);
                                        } else
                                        if (this.isTrue(state && state.val)) {
                                            this.log.debug('[SET INITIAL] ' + args.trueId + ' state is false und last 01  get old time');
                                            this.setValue(args.id, state.lc, callback);
                                        } else {
                                            this.log.error('[SET INITIAL] ' + args.trueId + ' unknown state to be evaluated in timeCount');
                                            callback();
                                        }
                                    });
                                } else
                                if (args.name === 'last10') {
                                    this.getForeignState(args.trueId, (err, state) => { // get actual values
                                        this.log.debug('[SET INITIAL] ' + args.trueId + ' objects ' + args.trueId + ' ' + args.name);
                                        this.log.debug('[SET INITIAL] ' + args.trueId + ' act value ' + (state && state.val) + ' time ' + (state && state.lc));
                                        if (this.isFalse(state && state.val)) {
                                            this.setValue(args.id, state.lc, callback);
                                            this.log.debug('[SET INITIAL] ' + args.trueId + ' state is false and last 10 get old time');
                                        } else
                                        if (this.isTrue(state && state.val)) {
                                            this.setValue(args.id, Date.now(), callback);
                                            this.log.debug('[SET INITIAL] ' + args.trueId + ' state is true and last 10 get now as lastChange');
                                        } else {
                                            this.log.error('[SET INITIAL] ' + args.trueId + ' unknown state to be evaluated in timeCount');
                                            callback();
                                        }
                                    });
                                } else
                                if (args.name === 'lastPulse') {
                                    this.getForeignState(args.trueId, (err, state) => { // get actual values
                                        this.log.debug('[SET INITIAL] ' + args.trueId + ' objects ' + args.trueId + ' ' + args.name);
                                        this.log.debug('[SET INITIAL] ' + args.trueId + ' act value ' + (state && state.val) + ' time ' + (state && state.lc));
                                        if (this.isTrue(state && state.val) || this.isFalse(state && state.val)) { //egal was drin ist, es muß zum Wertebereich passen und es wird auf den Wert von lastPulse gesetzt
                                            this.setValue(args.id, state.val, callback);
                                            this.log.debug('[SET INITIAL] ' + args.trueId + ' state was ' + state.val + ' and lastPulse get old time');
                                        } else {
                                            this.log.error('[SET INITIAL] ' + args.trueId + ' unknown state to be evaluated in count');
                                            callback();
                                        }
                                    });
                                } else
                                if (args.name === 'last') { // speichern des aktuellen Zustandes für timecount, sofern mit poll gleiche Zustände geholt werden und keinen Signalwechsel darstellen
                                    this.getForeignState(args.trueId, (err, state) => { // get actual value for the state in timecount
                                        this.log.debug('[SET INITIAL] ' + args.trueId + ' objects ' + args.trueId + ' ' + args.name);
                                        this.log.debug('[SET INITIAL] ' + args.trueId + ' act value ' + (state && state.val) + ' time ' + (state && state.lc));
                                        if (this.isTrue(state && state.val) || this.isFalse(state && state.val)) { //egal was drin ist, es muß zum Wertebereich passen und es wird auf den Wert von lastPulse gesetzt
                                            this.setValue(args.id, state.val, callback);
                                            this.log.debug('[SET INITIAL] ' + args.trueId + ' state is ' + state.val + ' and set to last ');
                                        } else {
                                            this.log.error('[SET INITIAL] ' + args.trueId + ' unknown state to be evaluated in count');
                                            callback();
                                        }
                                    });
                                } else {
                                    callback();
                                }
                            }
                        } else {
                            callback();
                        }
                    });
                }
            });
        }
        isStart && this.processTasks();
    }

    defineObject(type, id, name, unit) {
        const isStart = !this.tasks.length;
        // Create channels
        this.tasks.push({
            name: 'setObjectNotExists',
            id: 'save.' + type + '.' + id,
            obj: {
                type: 'channel',
                common: {
                    name: 'Save values for ' + name,
                    role: 'sensor'
                },
                native: {
                    addr: id
                }
            }
        });
        this.tasks.push({
            name: 'setObjectNotExists',
            id: 'temp.' + type + '.' + id,
            obj: {
                type: 'channel',
                common: {
                    name: 'Temporary value for ' + name,
                    role: 'sensor',
                    // expert: true
                },
                native: {
                    addr: id
                }
            }
        });

        // states for the saved values
        const nameObjectType = this.nameObjects[type];
        let objects = nameObjectType.save;
        for (let s = 0; s < objects.length; s++) {
            if (!stateObjects[objects[s]]) {
                this.log.error('[CREATION] State ' + objects[s] + ' unknown');
                continue;
            }
            const obj = JSON.parse(JSON.stringify(stateObjects[objects[s]]));
            if (!obj) {
                this.log.error('[CREATION] Unknown state: ' + objects[s]);
                continue;
            }
            obj.native.addr = id;
            if (unit && objects[s] !== 'dayCount') {
                obj.common.unit = unit;
            }
            this.tasks.push({
                name: 'setObjectNotExists',
                id: 'save.' + type + '.' + id + '.' + objects[s],
                obj
            });
        }

        // states for the temporary values
        objects = nameObjectType.temp;
        for (let s = 0; s < objects.length; s++) {
            if (!stateObjects[objects[s]]) {
                this.log.error('[CREATION] State ' + objects[s] + ' unknown');
                continue;
            }
            const obj = JSON.parse(JSON.stringify(stateObjects[objects[s]]));
            if (!obj) {
                this.log.error('[CREATION] Unknown state: ' + objects[s]);
                continue;
            }
            obj.native.addr = id;
            // obj.common.expert = true;
            if (unit && objects[s] !== 'dayCount') {
                obj.common.unit = unit;
            } else if (obj.common.unit !== undefined) {
                delete obj.common.unit;
            }
            this.tasks.push({
                name: 'setObjectNotExists',
                id: 'temp.' + type + '.' + id + '.' + objects[s],
                obj
            });
        }
        isStart && this.processTasks();
        this.setInitial(type, id);
    }

    setupObjects(ids, callback, isStart, noSubscribe) {
        if (!ids || !ids.length) {
            isStart && this.processTasks();
            return callback && callback();
        }
        if (isStart === undefined) {
            isStart = !this.tasks.length;
        }
        const id = ids.shift();
        const obj = this.statDP[id];
        if (!obj) {
            return setImmediate(this.setupObjects, ids, callback, isStart);
        }
        let subscribed = !!noSubscribe;
        if (!obj.groupFactor && obj.groupFactor !== '0' && obj.groupFactor !== 0) {
            obj.groupFactor = parseFloat(this.config.groupFactor) || 1;
        } else {
            obj.groupFactor = parseFloat(obj.groupFactor) || 1;
        }
        if (!obj.impUnitPerImpulse && obj.impUnitPerImpulse !== '0' && obj.impUnitPerImpulse !== 0) {
            obj.impUnitPerImpulse = parseInt(this.config.impUnitPerImpulse, 10) || 1;
        } else {
            obj.impUnitPerImpulse = parseInt(obj.impUnitPerImpulse, 10) || 1;
        }
        // merge der Kosten in den Datensatz
        if (obj.sumGroup && ((obj.count && obj.sumCount) || obj.sumDelta)) {
            this.groups[obj.sumGroup] = this.groups[obj.sumGroup] || { config: this.config.groups.find(g => g.id === obj.sumGroup), items: [] };
            if (this.groups[obj.sumGroup].items.indexOf(id) === -1) {
                this.groups[obj.sumGroup].items.push(id);
            }
        }

        // Function is called with the custom objects
        this.log.debug('[CREATION] ============================== ' + id + ' =============================');
        this.log.debug('[CREATION] setup of object ' + JSON.stringify(obj));
        const logName = obj.logName;
        if (obj.avg && !obj.sumDelta) {
            if (!this.typeObjects.avg || this.typeObjects.avg.indexOf(id) === -1) {
                this.typeObjects.avg = this.typeObjects.avg || [];
                this.typeObjects.avg.push(id);
            }
            this.defineObject('avg', id, logName); //type, id, name
            this.tasks.push({
                name: 'setObjectNotExists',
                subscribe: !subscribed && id,
                id: 'save.avg',
                obj: {
                    type: 'channel',
                    common: {
                        name: 'Average values',
                        role: 'sensor'
                    },
                    native: {}
                }
            });
            subscribed = true;
        }
        //	minmax over time
        if (obj.minmax) {
            if (!this.typeObjects.minmax || this.typeObjects.minmax.indexOf(id) === -1) {
                this.typeObjects.minmax = this.typeObjects.minmax || [];
                this.typeObjects.minmax.push(id);
            }
            this.defineObject('minmax', id, logName); //type, id, name
            this.tasks.push({
                name: 'setObjectNotExists',
                subscribe: !subscribed && id,
                id: 'save.minmax',
                obj: {
                    type: 'channel',
                    common: {
                        name: 'MinMax values',
                        role: 'sensor'
                    },
                    native: {}
                }
            });
            subscribed = true;
        }
        // 5minutes Values can only be determined when counting
        this.log.debug('[CREATION] fiveMin = ' + obj.fiveMin + ',  count =  ' + obj.count);

        if (obj.fiveMin && obj.count) {
            if (!this.typeObjects.fiveMin || this.typeObjects.fiveMin.indexOf(id) === -1) {
                this.typeObjects.fiveMin = this.typeObjects.fiveMin || [];
                this.typeObjects.fiveMin.push(id);
            }
            this.defineObject('fiveMin', id, logName); //type, id, name
            this.tasks.push({
                name: 'setObjectNotExists',
                subscribe: !subscribed && id,
                id: 'save.fiveMin',
                obj: {
                    type: 'channel',
                    common: {
                        name: '5min Consumption',
                        role: 'sensor'
                    },
                    native: {}
                }
            });
            subscribed = true;
        }

        if (obj.timeCount) {
            if (!this.typeObjects.timeCount || this.typeObjects.timeCount.indexOf(id) === -1) {
                this.typeObjects.timeCount = this.typeObjects.timeCount || [];
                this.typeObjects.timeCount.push(id);
            }
            this.defineObject('timeCount', id, logName); //type, id, name
            this.tasks.push({
                name: 'setObjectNotExists',
                subscribe: !subscribed && id,
                id: 'save.timeCount',
                obj: {
                    type: 'channel',
                    common: {
                        name: 'Operation time counter',
                        role: 'sensor'
                    },
                    native: {}
                }
            });
            subscribed = true;
        }

        if (obj.count) {
            if (!this.typeObjects.count || this.typeObjects.count.indexOf(id) === -1) {
                this.typeObjects.count = this.typeObjects.count || [];
                this.typeObjects.count.push(id);
            }
            this.defineObject('count', id, logName); //type, id, name
            this.tasks.push({
                name: 'setObjectNotExists',
                subscribe: !subscribed && id,
                id: 'save.count',
                obj: {
                    type: 'channel',
                    common: {
                        name: 'Impulse counter, Counting of switching cycles',
                        role: 'sensor'
                    },
                    native: {}
                }
            });
            subscribed = true;
        }

        // Conversion pulses into consumption is only useful if pulses exist
        if (obj.sumCount && obj.count) {
            if (!this.typeObjects.sumCount || this.typeObjects.sumCount.indexOf(id) === -1) {
                this.typeObjects.sumCount = this.typeObjects.sumCount || [];
                this.typeObjects.sumCount.push(id);
            }
            this.defineObject('sumCount', id, logName, obj.unit); //type, id, name, Unit
            this.tasks.push({
                name: 'setObjectNotExists',
                subscribe: !subscribed && id,
                id: 'save.sumCount',
                obj: {
                    type: 'channel',
                    common: {
                        name: 'Consumption from impulse counter',
                        role: 'sensor'
                    },
                    native: {}
                }
            });
        }

        if (obj.sumDelta) {
            if (!this.typeObjects.sumDelta || this.typeObjects.sumDelta.indexOf(id) === -1) {
                this.typeObjects.sumDelta = this.typeObjects.sumDelta || [];
                this.typeObjects.sumDelta.push(id);
            }
            this.defineObject('sumDelta', id, logName); //type, id, name
            this.tasks.push({
                name: 'setObjectNotExists',
                subscribe: !subscribed && id,
                id: 'save.sumDelta',
                obj: {
                    type: 'channel',
                    common: {
                        name: 'Consumption',
                        role: 'sensor'
                    },
                    native: {}
                }
            });
            subscribed = true;
        }

        // sumGroup only makes sense if there are also the delta values
        if (obj.sumGroup && (obj.sumDelta || (obj.sumCount && obj.count))) {
            // submit sumgroupname for object creation
            if (this.groups[obj.sumGroup] && this.groups[obj.sumGroup].config) {
                if (!this.typeObjects.sumGroup || this.typeObjects.sumGroup.indexOf(obj.sumGroup) === -1) {
                    this.typeObjects.sumGroup = this.typeObjects.sumGroup || [];
                    this.typeObjects.sumGroup.push(obj.sumGroup);
                }
                this.defineObject('sumGroup', obj.sumGroup, 'Sum for ' + obj.sumGroup); // type, id ist der gruppenname, name
                this.tasks.push({
                    name: 'setObjectNotExists',
                    id: 'save.sumGroup',
                    obj: {
                        type: 'channel',
                        common: {
                            name: 'Total consumption',
                            role: 'sensor'
                        },
                        native: {}
                    }
                });
            } else {
                this.log.error('[CREATION] No group config found for ' + obj.sumGroup);
            }
        }
        setImmediate(this.setupObjects, ids, callback, isStart);
    }

    processTasks() {
        if (!this.tasks || !this.tasks.length) {
            this.units = {};
            return;
        }
        const task = this.tasks.shift();
        if (task.name === 'setObjectNotExists') {
            const attr = task.id.split('.').pop();
            // detect unit
            if (task.obj.native.addr &&
                task.obj.type === 'state' &&
                this.units[task.obj.native.addr] === undefined &&
                this.nameObjects.timeCount.temp.indexOf(attr) === -1 &&
                !task.id.match(/\.dayCount$/) &&       // !! Problem mit .?
                !task.id.startsWith('save.sumGroup.') &&
                !task.id.startsWith('temp.sumGroup.')) {
                this.getForeignObject(task.obj.native.addr, (err, obj) => {
                    if (obj && obj.common.unit) {
                        task.obj.common.unit = obj.common.unit;
                        this.units[task.obj.native.addr] = obj.common.unit;
                    } else {
                        this.units[task.obj.native.addr] = '';
                    }

                    this.setObjectNotExists(task.id, task.obj, (err, isCreated) => {
                        if (isCreated) {
                            this.log.debug('[CREATION] ' + task.id);
                        }
                        if (task.subscribe) {
                            this.subscribeForeignStates(task.subscribe, () => {
                                setImmediate(this.processTasks);
                            });
                        } else {
                            setImmediate(this.processTasks);
                        }
                    });
                });
            } else {
                if (task.obj.native.addr && !task.id.match(/\.dayCount$/)) { // !! Problem mit .?
                    if (this.units[task.obj.native.addr] !== undefined) {
                        if (this.units[task.obj.native.addr]) {
                            task.obj.common.unit = this.units[task.obj.native.addr];
                        }
                    } else
                    if (task.id.startsWith('save.sumGroup.') || task.id.startsWith('temp.sumGroup.')) {
                        task.obj.common.unit = this.groups[task.obj.native.addr] && this.groups[task.obj.native.addr].config && this.groups[task.obj.native.addr].config.priceUnit ? this.groups[task.obj.native.addr].config.priceUnit.split('/')[0] : '€';
                    }
                }

                this.setObjectNotExists(task.id, task.obj, (err, isCreated) => {
                    if (isCreated) {
                        this.log.debug('[CREATION] ' + task.id);
                    }
                    if (task.subscribe) {
                        this.subscribeForeignStates(task.subscribe, () => setImmediate(this.processTasks));
                    } else {
                        setImmediate(this.processTasks);
                    }
                });
            }
        } else if (task.name === 'async') {
            if (typeof task.callback === 'function') {
                task.callback(task.args, () => setImmediate(this.processTasks));
            } else {
                this.log.error('error');
            }
        }
    }

    padding(text, num) {
        if (text.length > num) {
            return text;
        } else {
            return text + new Array(num - text.length).join(' ');
        }
    }

    getCronStat() {
        for (const type in this.crons) {
            if (this.crons.hasOwnProperty(type) && this.crons[type]) {
                this.log.debug('[INFO] ' + this.padding(type, 15) + '      status = ' + this.crons[type].running + ' next event: ' + this.timeConverter(this.crons[type].nextDates()));
            }
        }
    }

    async onReady() {
        // typeObjects is rebuilt after starting the adapter
        // deleting data points during runtime must be cleaned up in both arrays
        // reading the setting (here come with other setting!)
        this.getObjectView('custom', 'state', {}, (err, doc) => {
            let objCount = 0;
            if (doc && doc.rows) {
                for (let i = 0, l = doc.rows.length; i < l; i++) {
                    if (doc.rows[i].value) {
                        const id = doc.rows[i].id;
                        const custom = doc.rows[i].value;
                        if (!custom || !custom[this.namespace] || !custom[this.namespace].enabled) continue;
                        this.statDP[id] = custom[this.namespace]; // all-inclusive assumption of all answers
                        objCount++;
                        this.log.info('[CREATION] enabled statistics for ' + id);
                    }
                }
                const keys = Object.keys(this.statDP);
                this.setupObjects(keys, () => {
                    this.log.info('[INFO] statistics observes ' + objCount + ' values after startup');
                    for (const type in this.typeObjects) {
                        if (this.typeObjects.hasOwnProperty(type)) {
                            for (let i = 0; i < this.typeObjects[type].length; i++) {
                                this.log.info('[INFO] monitor "' + this.typeObjects[type][i] + '" as ' + type);
                            }
                        }
                    }
                    this.getCronStat();
                });
            }
        });

        // create cron-jobs
        const timezone = this.config.timezone || 'Europe/Berlin';

        // every 5min
        try {
            this.crons.avg5min = new CronJob('*/5 * * * *',
                () => this.fiveMin(),
                () => this.log.debug('stopped 5min'), // This function is executed when the job stops
                true,
                timezone
            );
        } catch (e) {
    			this.log.error('creating cron errored with :' + e);
        }

        // Every 15 minutes
        try {
            this.crons.fifteenMinSave = new CronJob('0,15,30,45 * * * *',
                () => this.saveValues('15Min'),
                () => this.log.debug('stopped daySave'), // This function is executed when the job stops
                true,
                timezone
            );
        } catch (e) {
    			this.log.error('creating cron errored with :' + e);
        }

        // Hourly at 00 min
        try {
            this.crons.hourSave = new CronJob('0 * * * *',
                () => this.saveValues('hour'),
                () => this.log.debug('stopped daySave'), // This function is executed when the job stops
                true,
                timezone
            );
        } catch (e) {
    			this.log.error('creating cron errored with :' + e);
        }

        // daily um 23:59:58
        try {
            this.crons.dayTriggerTimeCount = new CronJob('58 59 23 * * *',
                () => this.setTimeCountMidnight(),
                () => this.log.debug('stopped timecount midnight trigger'), // This function is executed when the job stops
                true,
                timezone
            );
        } catch (e) {
    			this.log.error('creating cron errored with :' + e);
        }

        // daily um 00:00
        try {
            this.crons.daySave = new CronJob('0 0 * * *',
                () => this.saveValues('day'),
                () => this.log.debug('stopped daySave'), // This function is executed when the job stops
                true,
                timezone
            );
        } catch (e) {
    			this.log.error('creating cron errored with :' + e);
        }

        // Monday 00:00
        try {
            this.crons.weekSave = new CronJob('0 0 * * 1',
                () => this.saveValues('week'),
                () => this.log.debug('stopped week'), // This function is executed when the job stops
                true,
                timezone
            );
        } catch (e) {
    			this.log.error('creating cron errored with :' + e);
        }

        // Monthly at 1 of every month at 00:00
        try {
            this.crons.monthSave = new CronJob('0 0 1 * *',
                () => this.saveValues('month'),
                () => this.log.debug('stopped month'), // This function is executed when the job stops
                true,
                timezone
            );
        } catch (e) {
    			this.log.error('creating cron errored with :' + e);
        }

        // Quarter
        try {
            this.crons.quarterSave = new CronJob('0 0 1 0,3,6,9 *',
                () => this.saveValues('quarter'),
                () => this.log.debug('stopped quarter'), // This function is executed when the job stops
                true,
                timezone
            );
        } catch (e) {
    			this.log.error('creating cron errored with :' + e);
        }

        // New year
        try {
            this.crons.yearSave = new CronJob('0 0 1 0 *',
                () => this.saveValues('year'), // Months is value range 0-11
                () => this.log.debug('stopped yearSave'),
                true,
                timezone
            );
        } catch (e) {
    			this.log.error('creating cron errored with :' + e);
        }

        // subscribe to objects, so the settings in the object are arriving to the adapter
        this.subscribeForeignObjects('*');
    }

    onUnload(callback) {
        try {
            this.stopCrons();
            callback();
        } catch (e) {
            callback();
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Statistics(options);
} else {
    // otherwise start the instance directly
    new Statistics();
}