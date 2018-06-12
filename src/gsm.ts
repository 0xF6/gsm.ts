import * as SerialPort from 'serialport';
import { PDUParser } from 'pdu.ts';
import { EventEmitter } from 'events';
import { getLogger, Logger } from 'log4js';
import { HayesCommand } from './HayesCommand';
import isGSMAlphabet from './Utils/isGSMAlphabet';
import { PartsSendQueue } from './PartsSendQueue';
export type ModemOptions = {
    port: string;
    notify_port: string;
    ports?: Array<string>;
    auto_hangup?: boolean;
    ussdTimeout?: number;
    commandsTimeout?: number;
    forever?: boolean;
    debug?: boolean;
};
export type Callback<T = any, E = any> = (err?: E, data?: T) => void;
export type Storage = '"ME"' | '"SM"' | '"ST"' | string;
export type Signal = { db: number, condition: "unknown" | "marginal" | "workable" | "good" | "excellent" };
export class Modem extends EventEmitter {
	/**
	 * Constructor for the modem
	 * Possible options:
	 *  ports
	 *  forever (if set to true, will keep trying to connect to modem even after it is disconnected. This can facilitate running this module as a daemon)
	 *  debug
	 *  auto_hangup
	 *  ussdTimeout
	 *  commandsTimeout
	 *
	 * Extends EventEmitter. Events:
	 *  message - new SMS has arrived
	 *  report - SMS status report has arrived
	 *  USSD - USSD has arrived
	 *  disconnect - modem is disconnected
	 */
    constructor(opts: ModemOptions) {
        super();

        if (opts.port !== undefined) this.ports.push(opts.port);
        if (opts.notify_port !== undefined) this.ports.push(opts.notify_port);
        if (opts.ports !== undefined) {
            for (let i = 0; i < opts.ports.length; ++i) this.ports.push(opts.ports[i]);
        }
        if (this.ports.length === 0) {
            console.error('ports are undefined');
            return null;
        }
        // Auto hang up calls
        this.autoHangup = opts.auto_hangup || false;

        this.ussdTimeout = opts.ussdTimeout || 15000;
        this.commandsTimeout = opts.commandsTimeout || 15000;

        this.forever = opts.forever;

        //this.connectingHandle;

        this.logger = getLogger("gsm");

        if (opts.debug)
            this.logger.level = "trace";
        else
            this.logger.level = "warn";

        this.resetVars();
    }

    public resetVars() {
        this.portErrors = 0;
        this.portConnected = 0;
        this.portCloses = 0;
        this.connected = false;

        this.serialPorts = [];
        this.buffers = [];
        this.bufferCursors = [];
        this.dataPort = null;

        this.textMode = false;
        this.echoMode = false;
        this.commandsStack = [];
        this.storages = {};
        this.manufacturer = 'UNKNOWN';
    }

    public connect(cb?: Callback) {
        for (let i = 0; i < this.ports.length; ++i) {
            this.connectPort(this.ports[i], cb);
        }
    }
    public connectPort(port: string, cb?: Callback): void {
        var serialPort = new SerialPort(port, {
            baudRate: 115200,
        });
        cb();
        var commandTimeout;
        serialPort.on(
            'open',
            function () {
                serialPort.write('AT\r', function (err) {
                    if (err) {
                        clearTimeout(commandTimeout);
                        this.onPortConnected(serialPort, -1, cb);
                    }
                });
                commandTimeout = setTimeout(
                    function () {
                        this.onPortConnected(serialPort, 0, cb);
                    }.bind(this),
                    5000
                );
            }.bind(this)
        );
        var buf = new Buffer(256 * 1024), bufCursor = 0;
        var onData = async function (data) {
            if (buf.length < data.length + bufCursor) {
                bufCursor = 0; return;
            }
            data.copy(buf, bufCursor);
            bufCursor += data.length;
            if (buf[bufCursor - 1] === 13 || buf[bufCursor - 1] === 10) {
                var str = buf.slice(0, bufCursor).toString();
                this.logger.debug('AT response: %s', str.trim());
                serialPort.removeListener('data', onData);
                if (str.indexOf('OK') !== -1 || str.indexOf('AT') !== -1) {
                    clearTimeout(commandTimeout);
                    this.onPortConnected(serialPort, 1, cb);
                }
            }
        }
        serialPort.on('data', onData.bind(this));

        serialPort.on('error', function (err) {
            if (!this.forever) {
                this.logger.error('Port connect error: %s', err.message);
            }

            if (null !== commandTimeout) {
                clearTimeout(commandTimeout);
            }
            this.onPortConnected(serialPort, -1, cb);
        }.bind(this));
    }

    public onPortConnected(port, dataMode, cb?: Callback) {
        this.logger.debug('port %s datamode: %d', port.path, dataMode);
        if (dataMode === -1) {
            ++this.portErrors;
        } else {
            ++this.portConnected;
            this.serialPorts.push(port);

            port.removeAllListeners('error');
            port.removeAllListeners('data');
            port.on('error', this.serialPortError.bind(this));
            port.on('close', this.serialPortClosed.bind(this));

            var buf = new Buffer(256 * 1024);
            var cursor = 0;
            this.buffers.push(buf);
            this.bufferCursors.push(cursor);

            port.on('data', this.onData.bind(this, port, this.buffers.length - 1));
            if (1 === dataMode) {
                this.dataPort = port;
            }
        }

        if (this.portErrors + this.portConnected === this.ports.length) {
            if (null === this.dataPort) {
                if (!this.forever) {
                    this.logger.error('No data port found');
                }

                this.close();
                if (typeof cb === 'function') {
                    cb(new Error('NOT CONNECTED'));
                }
                if (this.forever) {
                    //Retry connecting in 1 sec
                    this.connectingHandle = setTimeout(function () {
                        this.logger.debug("Retrying to connect...");
                        this.resetVars();
                        this.connect(cb);
                    }.bind(this, cb), 1000);
                }
            } else {
                this.logger.debug('Connected, start configuring. Ports: ', this.serialPorts.length);
                this.connected = true;
                this.configureModem(cb);
            }
        }
    }
    /**
     * Closes connection to ports
     */
    public close(cb?: Callback) {
        this.logger.debug('Modem disconnect called');
        this.connected = false;

        try {
            for (let i; i < this.serialPorts.length; ++i) {
                this.serialPorts[i].close(this.onClose.bind(this, cb));
            }
        } catch (err) {
            this.logger.error('Error closing modem: %s', err.message);
        }
    }
    /**
     * Stops the reconnection loop and disconnects the modem if it is connected
     */
    public stopForever() {
        this.forever = false;
        if (this.connectingHandle) {
            clearTimeout(this.connectingHandle);
        }
        this.close();
    }
    /**
     * Pushes command to commands stack
     * @param cmd command
     * @param cb callback
     * @param waitFor wait for?
     */
    public sendCommand(cmd: string, cb?: Callback, waitFor?: any) {
        this.logger.debug('Send command: %s', cmd);
        if (!this.connected) {
            this.logger.debug('Not connected!', cmd);
            if (typeof cb === 'function') {
                process.nextTick(function () {
                    cb('ERROR: NOT CONNECTED');
                });
            }
            return;
        }
        var scmd = new HayesCommand(cmd, cb);
        if (waitFor !== undefined) {
            scmd.waitCommand = waitFor;
        } else {
            scmd.waitCommand = "OK";
        }
        this.commandsStack.push(scmd);
        if (this.commandsStack.length === 1) { //no previous commands are waiting in the stack, go ahead!
            this.sendNext();
        }
    }
    /**
     * Sends next command from stack
     */
    public sendNext() {
        if (this.commandsStack.length === 0 || this.connected === false) {
            return;
        }
        var cmd = this.commandsStack[0];
        if (cmd && !cmd.sent) {
            cmd.startTimer(this.commandsTimeout, function () {
                this.logger.debug('command %s timedout', cmd.cmd);
                this.emit('error', new Error('TIMEOUT'));
                this.commandsStack.splice(0, 1);
                this.sendNext();
            }.bind(this));
            this.writeToSerial(cmd);
        }
    }
    /**
     * Writes command to serial port
     * @param cmd command
     */
    private writeToSerial(cmd: HayesCommand) {
        cmd.sent = true;
        this.willReceiveEcho = true;
        this.logger.debug('<serial> <-----', cmd.toString());
        this.dataPort.write(cmd.toString(), function (err) {
            if (err) {
                this.logger.error('Error sending command:', cmd.toString(), 'error:', err);
                this.sendNext();
            }
        }.bind(this));
    }
    /**
     * handles notification of rings, messages and USSD
     */
    public handleNotification(line: string): boolean {
        var handled = false, match, smsId, storage;
        if (!this.messageParts) {
            this.messageParts = {};
        }
        if (line.substr(0, 5) === '+CMTI') {
            match = line.match(/\+CMTI:\s*"?([A-Za-z0-9]+)"?,(\d+)/);
            if (null !== match && match.length > 2) {
                handled = true;
                storage = match[1];
                smsId = parseInt(match[2], 10);
                this.getSMS(storage, smsId, function (err, msg) {
                    if (err === undefined) {
                        this.deleteSMS(smsId, function (err) {
                            if (err) {
                                this.logger.error('Unable to delete incoming message!!', err.message);
                            }
                        });
                        if (msg.udh && msg.udh.parts && msg.udh.parts > 1) {
                            //We still emit a message
                            this.emit('message', msg);

                            //We should assemble this message before passing it on
                            if (!this.messageParts[msg.udh.reference_number]) {
                                this.messageParts[msg.udh.reference_number] = {};
                                this.messageParts[msg.udh.reference_number].parts_remaining = msg.udh.parts;
                                this.messageParts[msg.udh.reference_number].text = [];
                                for (var i = 0; i < msg.udh.parts; i++) {
                                    this.messageParts[msg.udh.reference_number].text.push("");
                                }
                            }
                            this.messageParts[msg.udh.reference_number].text[msg.udh.current_part - 1] = msg.text;
                            this.messageParts[msg.udh.reference_number].parts_remaining--;
                            if (this.messageParts[msg.udh.reference_number].parts_remaining === 0) {
                                var nmsg = JSON.parse(JSON.stringify(msg));

                                delete nmsg.smsc_tpdu;
                                delete nmsg.tpdu_type;
                                delete nmsg.udh;

                                nmsg.text = "";

                                for (var i = 0; i < msg.udh.parts; i++) {
                                    nmsg.text += this.messageParts[msg.udh.reference_number].text[i];
                                }
                                delete this.messageParts[msg.udh.reference_number];
                                this.emit('messagereceived', nmsg);
                            }
                        }
                        else {
                            this.emit('message', msg);
                            this.emit('messagereceived', msg);
                        }
                    }
                }.bind(this));
            }
        } else if (line.substr(0, 5) === '+CDSI') {
            match = line.match(/\+CDSI:\s*"?([A-Za-z0-9]+)"?,(\d+)/);
            if (null !== match && match.length > 2) {
                handled = true;
                storage = match[1];
                smsId = parseInt(match[2], 10);
                this.getSMS(storage, smsId, function (err, msg) {
                    if (err === undefined) {
                        this.deleteSMS(smsId, function (err) {
                            if (err) {
                                this.logger.error('Unable to delete incoming report!!', err.message);
                            }
                        }.bind(this));

                        this.emit('report', msg);

                        var trackingObj = this.deliveryParts[msg.reference];
                        if (trackingObj) {
                            trackingObj.parts--;
                            if (!trackingObj.deliveryReports) {
                                trackingObj.deliveryReports = [];
                            }
                            trackingObj.deliveryReports.push(msg);
                            delete this.deliveryParts[msg.reference];
                        }

                        if (trackingObj && trackingObj.parts === 0) {
                            var reportObj: any = {};
                            reportObj.reports = trackingObj.deliveryReports;
                            reportObj.reports = reportObj.reports.sort(function (a, b) { return a.reference - b.reference });
                            reportObj.isDeliveredSuccessfully = true;
                            reportObj.references = [];
                            reportObj.reports.forEach(function (report) {
                                /* We handle only 00 as its the most common success scenario
                                0x00  Short message delivered successfully
                                0x01  Forwarded, but status unknown
                                0x02  Replaced
                                0x20  Congestion, still trying
                                0x21  Recipient busy, still trying
                                0x22  No response recipient, still trying
                                0x23  Service rejected, still trying
                                0x24  QOS not available, still trying
                                0x25  Recipient error, still trying
                                0x40  RPC Error
                                0x41  Incompatible destination
                                0x42  Connection rejected
                                0x43  Not obtainable
                                0x44  QOS not available
                                0x45  No internetworking available
                                0x46  Message expired
                                0x47  Message deleted by sender
                                0x48  Message deleted by SMSC
                                0x49  Does not exist */
                                reportObj.references.push(report.reference);
                                reportObj.isDeliveredSuccessfully = (reportObj.isDeliveredSuccessfully && report.status === "00");
                            });
                            trackingObj = null;
                            this.emit('reportreceived', reportObj);
                        }
                    }
                }.bind(this));
            }
        } else if (line.substr(0, 5) === '+CUSD') {
            match = line.match(/\+CUSD:\s*(\d),"?([0-9A-F]+)"?,(\d*)/);
            if (match !== null && match.length === 4) {
                handled = true;
                this.emit('USSD', parseInt(match[1], 10), match[2], parseInt(match[3], 10));
            }
        } else if (line.substr(0, 4) === 'RING') {
            if (this.autoHangup) {
                this.sendCommand('ATH');
            }
            handled = true;
        }
        else if (line.substr(0, 8) == '+CLIP: "') {
            match = line.match(/\+CLIP: "(.*)"/);
            if (match) {
                this.emit('call', match[1]);
            }
            handled = true;
        }
        else if (line.substr(0, 5) === '^CEND') {
            handled = true;
        }
        else if (line.substr(0, 10) === '^DSFLOWRPT') {
            //These events are emitted by modem when it is connected to internet through ppp
            //See: http://www.sakis3g.com/
            handled = true;
        }
        else if (line.substr(0, 5) === '^BOOT') {
            handled = true;
        }
        return handled;
    }
    /**
     * Disables ^RSSI status notifications
     */
    public disableStatusNotifications() {
        this.sendCommand('AT^CURC?', function (data) {
            if (data.indexOf('COMMAND NOT SUPPORT') === -1 && data.indexOf('ERROR') === -1) {
                this.sendCommand('AT^CURC=0');
            }
        }.bind(this));
    }
    /**
     * Sets modem's text mode
     * @param textMode boolean
     */
    public setTextMode(textMode: boolean, cb?: Callback) {
        this.sendCommand('AT+CMGF=' + (textMode === true ? '1' : '0'), function (data) {
            if (-1 !== data.indexOf('OK')) {
                this.textMode = textMode;
            }
            if (typeof cb === 'function') {
                cb(undefined, this.textMode);
            }
        }.bind(this));
    }
    /**
     * Sets echo mode to on/off
     */
    public setEchoMode(state: boolean, cb?: Callback) {
        this.sendCommand('ATE' + (state ? '1' : '0'), function (data) {
            if (-1 !== data.indexOf('OK')) {
                this.echoMode = state;
            }
            if (typeof cb === 'function') {
                cb(undefined, this.echoMode);
            }
        }.bind(this));
    }
    /**
     * Gets current modem's SMS Center
     */
    public getSMSCenter(cb?: Callback) {
        this.sendCommand('AT+CSCA?', function (data) {
            if (typeof cb === 'function') {
                var match = data.match(/\+CSCA:\s*"(.?[0-9]*)".?,(\d*)/);
                if (match) {
                    cb(undefined, match[1]);
                } else {
                    cb(new Error('NOT SUPPORTED'));
                }
            }
        });
    }
    /**
     * Receives all short messages stored in the modem in terminal's memory
     * Deprecated
     */
    public getAllSMS(cb?: Callback) {
        this.getMessagesFromStorage('"ME"', cb);
    }
    /**
     * Receives all short messages stored in the modem in given storage
     */
    public getMessagesFromStorage(storage: Storage, cb?: Callback) {
        this.setReadStorage(storage, function (err) {
            if (err) {
                if (typeof cb === 'function') {
                    cb(err);
                }
                return;
            }
            this.sendCommand('AT+CMGL=' + (this.textMode ? '"ALL"' : 4), function (data) {
                if (typeof cb === 'function') {
                    if (data.indexOf('OK') === -1) {
                        cb(new Error(data));
                        return;
                    }
                    var ret = {};
                    var arr = data.split('\r\n');
                    var i, msgStruct, index, match;
                    for (i = 0; i < arr.length; ++i) {
                        if (!this.textMode) {
                            match = arr[i].match(/\+CMGL:\s*(\d+),(\d+),(\w*),(\d+)/);
                            if (match !== null && match.length > 4) {
                                msgStruct = PDUParser.Parse(arr[++i]);
                                index = match[1];
                                msgStruct.status = parseInt(match[2], 10);
                                msgStruct.alpha = match[3];
                                msgStruct.length = parseInt(match[4], 10);
                                ret[index] = msgStruct;
                            }
                        } else {
                            //TODO: handle text mode
                            this.logger.error('Text mode is not supported right now', arr[i]);
                        }
                    }
                    cb(undefined, ret);
                }
            }.bind(this));
        }.bind(this));
    }
    /**
     * Returns current message storages
     */
    public getCurrentMessageStorages(cb?: Callback) {
        this.sendCommand('AT+CPMS?', function (data) {
            if (data.indexOf('OK') !== -1) {
                var match = data.match(/\+CPMS:\s+("[A-Za-z0-9]+"),(\d+),(\d+),("[A-Za-z0-9]+"),(\d+),(\d+),("[A-Za-z0-9]+"),(\d+),(\d+)/);
                if (match && match.length > 9) {
                    var ret = {
                        storage1: {
                            storage: match[1],
                            current: parseInt(match[2], 10),
                            max: parseInt(match[3], 10)
                        },
                        storage2: {
                            storage: match[4],
                            current: parseInt(match[5], 10),
                            max: parseInt(match[6], 10)
                        },
                        storage3: {
                            storage: match[7],
                            current: parseInt(match[8], 10),
                            max: parseInt(match[9], 10)
                        },
                    };
                    cb(undefined, ret);
                } else {
                    cb(new Error('NOT MATCHED'));
                }
            } else {
                cb(new Error(data));
            }
        });
    }
    /**
     * Returns boolean whether modem supports given storage
     */
    public supportsStorage(storage: Storage, cb?: Callback) {
        if (storage[0] !== '"') { storage = '"' + storage + '"'; }
        this.getStorages(function (err, storages) {
            if (typeof cb === 'function') {
                if (!err) {
                    var i;
                    for (i = 0; i < storages.read.length; ++i) {
                        if (storages.read[i] === storage) {
                            cb(undefined, true);
                            return;
                        }
                    }
                    cb(undefined, false);
                } else {
                    cb(err);
                }
            }
        });
    }
    /**
     * Returns possible storages for inbox messages
     */
    public getStorages(cb?: Callback) {
        this.sendCommand('AT+CPMS=?', function (data) {
            if (typeof cb === 'function') {
                if (data.indexOf('OK') !== -1) {
                    var match = data.match(/\+CPMS:\s+\(([^\)]*)\),\(([^\)]*)\),\(([^\)]*)\)/);
                    if (match && match.length > 3) {
                        var ret = {
                            read: match[1].split(','),
                            outbox: match[2].split(','),
                            inbox: match[3].split(',')
                        };
                        cb(undefined, ret);
                    }
                    else cb(new Error('PARSE ERROR'));
                }
                else cb(new Error(data));
            }
        });
    }
    /**
     * Sets storage for inbox messages
     */
    public setReadStorage(storage: Storage, cb?: Callback) {
        if (storage[0] !== '"')
            storage = `"${storage}"`;
        this.sendCommand('AT+CPMS=' + storage + ',,', function (data) {
            if (typeof cb === 'function') {
                if (data.indexOf('OK') !== -1)
                    cb(undefined);
                else
                    cb(new Error(data));
            }
        });
    }
    /**
     * Sets storage for inbox messages
     */
    public setInboxOutboxStorage(inbox: Storage, outbox: Storage, cb: Callback) {
        if (inbox[0] !== '"') { inbox = '"' + inbox + '"'; }
        if (outbox[0] !== '"') { outbox = '"' + outbox + '"'; }
        this.sendCommand('AT+CPMS=' + inbox + ',' + outbox + ',' + inbox, function (data) {
            if (typeof cb === 'function') {
                if (data.indexOf('OK') !== -1)
                    cb(undefined);
                else
                    cb(new Error(data));
            }
        });
    }
    /**
     * Requests SMS by id
     * @param id int of the SMS to get
     * @param cb function to callback. Function should receive dictionary containing the parsed pdu message
     */
    public getSMS(storage: Storage, id: number, cb?: Callback) {
        var readMessage = function () {
            this.sendCommand(`AT+CMGR=${id}`, (data) => {
                if (typeof cb === 'function') {
                    if (-1 === data.indexOf('OK')) {
                        cb(new Error(data));
                        return;
                    }
                    var arr = data.split('\r\n');
                    var i, match, msgStruct;
                    for (i = 0; i < arr.length; ++i) {
                        match = arr[i].match(/\+CMGR:\s+(\d*),(\w*),(\d+)/);
                        if (null !== match && match.length > 3) {
                            msgStruct = PDUParser.Parse(arr[++i]);
                            cb(undefined, msgStruct);
                            break;
                        }
                    }
                }
            });
        }.bind(this);

        if (storage !== null) {
            this.setReadStorage(storage, function (err) {
                if (err) {
                    if (typeof cb === 'function') cb(err);
                    return;
                }
                readMessage();
            }.bind(this));
        }
        else
            readMessage();
    }
    /**
     * Sends SMS to the recepient.
     * @param message dictionary with possible keys:
     *  receiver - MSISDN of the recepient (required)
     *  text - text to send (required)
     *  receiver_type - 0x81 for local, 0x91 for international format
     *  encoding - 7bit or 16bit is supported. If not specified will be detected automatically
     *  request_status - if the modem should request delivery report
     *  smsc - SMS center to use (MSISDN) (default:use modem's default SMSC)
     *  smsc_type - SMS center type (0x81 for international and local, 0x91 for international format only) (default:0x81)
     */
    public sendSMS(message, cb?: Callback) {
        if (message.receiver === undefined || message.text === undefined) {
            cb(new Error('Either receiver or text is not specified'));
            return;
        }

        if (!this.textMode) {
            var opts = message;
            if (message.receiver && message.receiver.indexOf("+") === 0) {
                message.receiver = message.receiver.substring(1);
                opts.receiver_type = 0x91;
            }
            else {
                opts.receiver_type = 0x81;
            }

            if (message.smsc && message.smsc.indexOf("+") === 0) {
                message.smsc = message.smsc.substring(1);
                opts.smsc_type = 0x91;
            }
            else {
                opts.smsc_type = 0x81;
            }

            if (opts.encoding === undefined) {
                opts.encoding = isGSMAlphabet(opts.text) ? '7bit' : '16bit';
            }

            var encoded = PDUParser.Generate(opts);
            var queue = new PartsSendQueue(this, encoded, cb);
            queue.sendNext();
        }
    }

    public deleteAllSMS(cb?: Callback) {
        this.sendCommand('AT+CMGD=1,4', function (data) {
            if (typeof cb === 'function') {
                if (-1 === data.indexOf('OK')) {
                    cb(new Error(data));
                } else {
                    cb(undefined);
                }
            }
        });
    }
    public deleteSMS(smsId: number, cb?: Callback) {
        this.sendCommand('AT+CMGD=' + smsId, function (data) {
            if (typeof cb === 'function') {
                if (-1 === data.indexOf('OK'))
                    cb(new Error(data));
                else
                    cb(undefined);
            }
        });
    }
    /**
     * Requests custom USSD
     * @param ussd ussd command
     * @param cb callback
     */
    public getUSSD(ussd: string, cb?: Callback) {
        if (this.manufacturer.indexOf('HUAWEI') !== -1) {
            ussd = PDUParser.ussdEncode(ussd);
        }
        this.sendCommand('AT+CUSD=1,"' + ussd + '",15', function (data) {
            if (data.indexOf('OK') !== -1) {
                var processed = false;
                var USSDHandler = function (status, data, dcs) {
                    processed = true;
                    if (status === 1) { //cancel USSD session
                        this.sendCommand('AT+CUSD=2');
                    }
                    var encoding = PDUParser.detectEncoding(dcs);
                    var text = '';
                    if (encoding === '16bit') {
                        text = PDUParser.decode16Bit(data);
                    } else if (encoding === '7bit') {
                        text = PDUParser.decode7Bit(data);
                    } else {
                        cb(new Error('Unknown encoding'));
                        return;
                    }
                    cb(undefined, text);
                }.bind(this);

                this.once('USSD', USSDHandler);
                setTimeout(function () {
                    if (!processed) {
                        this.removeListener('USSD', USSDHandler);
                        cb(new Error('timeout'));
                    }
                }.bind(this), this.ussdTimeout);
            }
        }.bind(this));
    }
    /**
     * Returns modem's IMSI
     * @param cb Callback
     */
    public getIMSI(cb?: Callback) {
        this.sendCommand('AT+CIMI', function (data) {
            if (typeof cb === 'function') {
                var match = data.match(/(\d{10,})\r\n/);
                if (null !== match && match.length === 2)
                    cb(undefined, match[1]);
                else
                    cb(new Error(data));
            }
        });
    }
    /**
     * Returns modem's IMEI
     */
    public getIMEI(cb?: Callback) {
        this.sendCommand('AT+CGSN', function (data) {
            if (typeof cb === 'function') {
                var match = data.match(/(\d{10,})\r\n/);
                if (null !== match && match.length === 2) {
                    cb(undefined, match[1]);
                } else {
                    cb(new Error('GET IMEI NOT SUPPORTED: ' + data));
                }
            }
        });
    }
    /**
     * Returns modem's manufacturer
     */
    public getManufacturer(cb?: Callback) {
        this.sendCommand('AT+CGMI', function (data) {
            if (typeof cb === 'function') {
                if (data.indexOf('OK') === -1) {
                    cb(new Error(data));
                } else {
                    cb(undefined, data.split('\r\n')[0]);
                }
            }
        });
    }
    /**
     * Returns modem's model
     */
    public getModel(cb?: Callback) {
        this.sendCommand('AT+CGMM', function (data) {
            if (typeof cb === 'function') {
                if (data.indexOf('OK') === -1) {
                    cb(new Error(data));
                } else {
                    cb(undefined, data.split('\r\n')[0]);
                }
            }
        });
    }
    /**
     * Requests operator name or code
     * @param text boolean return operator name if true, code otherwise
     * @param cb to call on completion
     */
    public getOperator(text: string, cb?: Callback) {
        this.sendCommand('AT+COPS=3,' + (text ? '0' : '2') + ';+COPS?', function (operator) {
            var match = operator.match(/\+COPS: (\d*),(\d*),"?([\w \-]+)"?,(\d*)/);
            if (typeof cb === 'function') {
                if (null !== match && 4 < match.length) {
                    cb(undefined, match[3]);
                } else {
                    cb(new Error('GET OPERATOR NOT SUPPORTED'));
                }
            }
        }.bind(this));
    }
    /**
     * Returns if caller id is supported through emission of +CLIP messages
     * @param cb to call on completion
     */
    public getIsCallerIdSupported(cb?: Callback) {
        this.sendCommand('AT+CLIP=?', function (data) {
            var match = data.match(/\+CLIP: \((.*)\)/);
            if (typeof cb === 'function') {
                if (match) {
                    cb(undefined, match[1] === "0-1");
                } else {
                    cb(new Error('GET CALLER ID NOT SUPPORTED'));
                }
            }
        }.bind(this));
    }
    /**
     * Enables/disables caller id detection through +CLIP
     * @param cb to call on completion
     */
    public setSendCallerId(val, cb?: Callback) {
        this.sendCommand('AT+CLIP=' + (val ? "1" : "0"), function (data) {
            if (data.indexOf('OK') === -1) {
                cb(new Error(data));
            } else {
                cb(undefined);
            }
        }.bind(this));
    }
    /**
     * Requests current signal strength
     * @param cb function to call on completion. Returns dictionary with keys db and condition
     */
    public getSignalStrength(cb?: Callback<Signal>) {
        this.sendCommand('AT+CSQ', function (data) {
            if (typeof cb === 'function') {
                var match = data.match(/\+CSQ: (\d+),(\d*)/);
                if (null !== match && 2 < match.length) {
                    var scale = parseInt(match[1], 10);
                    if (scale === 99) {
                        cb(undefined, {
                            db: 0,
                            condition: 'unknown'
                        });
                    } else {
                        var db = -113 + scale * 2, condition;
                        if (db < -95) {
                            condition = 'marginal';
                        } else if (db < -85) {
                            condition = 'workable';
                        } else if (db < -75) {
                            condition = 'good';
                        } else {
                            condition = 'excellent';
                        }
                        cb(undefined, {
                            db: db,
                            condition: condition
                        });
                    }
                } else {
                    cb(new Error('GET SIGNAL NOT SUPPORTED'));
                }
            }
        });
    }
    /**
     * Sends custom AT command
     */
    public customATCommand(cmd: string, cb: Callback) {
        this.sendCommand(cmd, function (data) {
            if (typeof cb === 'function') {
                if (data.indexOf('OK') !== -1) {
                    cb(undefined, data);
                } else {
                    cb(new Error(data));
                }
            }
        });
    }
    private wait(time: number) {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                clearTimeout(timer);
                resolve();
            }, time);
        });
    }


    public configureModem(cb?: Callback) {
        //await this.wait(250);
        this.setEchoMode(false);
        //await this.wait(250);
        this.setTextMode(false);
        //await this.wait(250);
        this.disableStatusNotifications();
        //await this.wait(250);
        this.sendCommand('AT+CNMI=2,1,0,2,0', function (err, data) {
            if (data && data.indexOf("ERROR") >= 0) {
                this.logger.debug('Waiting for modem to be ready...');
                setTimeout(this.configureModem.bind(this, cb), 1000);
                return;
            }
            else {
                this.sendCommand('AT+CMEE=1');
                this.sendCommand('AT+CVHU=0');
                //this.sendCommand('AT+CMGL=4');
                //this.sendCommand('AT+CMGF=0');
                this.getManufacturer(function (err, manufacturer) {
                    if (!err) {
                        this.manufacturer = manufacturer.toUpperCase().trim();
                        if (this.manufacturer === 'OK') this.manufacturer = 'HUAWEI';
                    }
                }.bind(this));

                this.getStorages(function (err, storages) {
                    var i;
                    /*, supportOutboxME = false, supportInboxME = false;
                    if (!err) {
                        for (i = 0; i < storages.outbox.length; ++i) {
                            if (storages.outbox[i] === '"ME"') { supportOutboxME = true; break; }
                        }
                        for (i = 0; i < storages.inbox.length; ++i) {
                            if (storages.inbox[i] === '"ME"') { supportInboxME = true; break; }
                        }
                    }*/
                    //this.setInboxOutboxStorage(supportInboxME ? "ME" : "SM", supportOutboxME ? "ME" : "SM", function (err) {
                    this.setInboxOutboxStorage("SM", "SM", function (err) {
                        if (!err) {
                            this.getCurrentMessageStorages(function (err, storages) {
                                this.storages = storages;
                                if (typeof cb === 'function') {
                                    cb();
                                }
                                this.emit('connected');
                            }.bind(this));
                        } else {
                            this.logger.debug('Waiting for modem to be ready...');
                            setTimeout(this.configureModem.bind(this, cb), 1000);
                        }
                    }.bind(this));
                }.bind(this));
            }
        }.bind(this, cb));
    }

    public ports: Array<string> = [];
    public autoHangup: boolean;
    public ussdTimeout: number;
    public commandsTimeout: number;
    public forever: boolean;
    public portErrors: number;
    public portConnected: number;
    public portCloses: number;
    public connected: boolean;
    public serialPorts: any[];
    public buffers: any[];
    public bufferCursors: any[];
    public dataPort: any;
    public textMode: boolean;
    public echoMode: boolean;
    public commandsStack: HayesCommand[];
    public storages: {};
    public manufacturer: string;
    public logger: Logger;
    public connectingHandle: number;
    public willReceiveEcho: boolean;
    public messageParts: any;
    public deliveryParts: Array<any>

    // events

    private serialPortError(err) {
        this.logger.error('Serial port error: %s (%d)', err.message, err.code);
        this.emit('error', err);
    }
    private serialPortClosed() {
        if (this.connected) {
            ++this.portCloses;
            this.logger.debug('Serial port closed. Emit disconnect');
            this.emit('disconnect');
        }
        if (this.forever) {
            this.resetVars();
            this.connect();
        }
    }
    private onClose(cb?) {
        ++this.portCloses;
        this.logger.debug('Port was closed (%d / %d)', this.portCloses, this.serialPorts.length);
        if (this.portCloses === this.serialPorts.length) {
            this.logger.debug('All ports were closed');
            this.resetVars();
            this.logger.debug('... and variables cleared');
            if (typeof cb === 'function') {
                cb();
            }
        }
    }

    private onData(port, bufInd, data) {
        var buffer = this.buffers[bufInd];
        this.logger.debug('<serial> ----> %s ', port.path, data.toString());
        if (this.bufferCursors[bufInd] + data.length > buffer.length) { //Buffer overflow
            this.logger.error('Data buffer overflow');
            this.bufferCursors[bufInd] = 0;
        }
        data.copy(buffer, this.bufferCursors[bufInd]);
        this.bufferCursors[bufInd] += data.length;
        if (buffer[this.bufferCursors[bufInd] - 1] !== 10 && data.toString().indexOf('>') === -1) { return; }
        var resp = buffer.slice(0, this.bufferCursors[bufInd]).toString().trim();
        var arr = resp.split('\r\n');

        if (arr.length > 0) {
            var i, arrLength = arr.length, hadNotification = false;
            for (i = arrLength - 1; i >= 0; --i) {
                if (this.handleNotification(arr[i])) {
                    arr.splice(i, 1);
                    --arrLength;
                    hadNotification = true;
                }
            }
            if (hadNotification) {
                if (arrLength > 0) {
                    var b = new Buffer(arr.join('\r\n'));
                    b.copy(buffer, 0);
                    this.bufferCursors[bufInd] = b.length;
                } else {
                    this.bufferCursors[bufInd] = 0;
                    return;
                }
            }
            var lastLine = (arr[arrLength - 1]).trim();

            if (port === this.dataPort && this.commandsStack.length > 0) {
                var cmd = this.commandsStack[0];
                var b_Finished = false;

                let res = lastLine.indexOf('ERROR');
                res = lastLine.indexOf('NOT SUPPORT');
                if (lastLine.indexOf('ERROR') !== -1 || lastLine.indexOf('NOT SUPPORT') !== -1) {
                    b_Finished = true;
                } else if (cmd.waitCommand !== null) {
                    if (-1 !== resp.indexOf(cmd.waitCommand)) {
                        b_Finished = true;
                    }
                } else if (-1 !== lastLine.indexOf('OK')) {
                    b_Finished = true;
                }
                if (b_Finished) {
                    this.commandsStack.splice(0, 1);
                    if (this.echoMode) {
                        arr.splice(0, 1);
                    }
                    cmd.doCallback(resp);
                    this.bufferCursors[bufInd] = 0;
                    this.sendNext();
                }
            } else {
                this.logger.debug('Unhandled command: %s', resp);
                this.bufferCursors[bufInd] = 0;
            }
        }
    }

}
