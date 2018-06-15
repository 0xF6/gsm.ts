import { GSMModem, Callback } from './gsm';

/**
 * Queue to send parts of the message
 */
export class PartsSendQueue {
    public currentPart = 0;
    public references = [];
    public trackingObj: any;

    constructor(public modem: GSMModem, public parts: Array<any>, public cb?: Callback) { this.trackingObj = {}; }

    public onSend(data) {
        var match = data.match(/\+CMGS:\s*(\d+)/);
        if (match !== null && match.length > 1) {
            var ref = parseInt(match[1], 10);
            this.references.push(ref);
            this.trackingObj.references = this.references;
            this.modem.deliveryParts[ref] = this.trackingObj;
            this.sendNext();
        } else {
            if (typeof this.cb === 'function') {
                this.cb(new Error(data));
            }
        }
    }
    public sendNext() {
        if (this.currentPart >= this.parts.length) {
            if (typeof this.cb === 'function') {
                this.cb(undefined, this.references);
            }
        } else {
            this.modem.sendCommand('AT+CMGS=' + this.parts[this.currentPart].tpdu_length, undefined, '>');
            this.modem.sendCommand(this.parts[this.currentPart].smsc_tpdu + String.fromCharCode(26), this.onSend.bind(this));
            ++this.currentPart;
        }
    }
}