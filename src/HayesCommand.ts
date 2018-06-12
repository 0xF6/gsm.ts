/**
 * Hayes command structure
 */
export class HayesCommand
{
    public cmd: string;
    public response: string = null;
    public sent: boolean = false;
    public callback: Function = null;
    public waitCommand: string;
    public timeout: number;

    public constructor(hayesCommand: string, callback: Function)
    {
        this.cmd = hayesCommand;
        this.callback = callback;
    }

    public doCallback(response) {
        clearTimeout(this.timeout);
        if (this.response === null) 
        {
            this.response = response;
            if (typeof this.callback === 'function') 
            this.callback(response);
        }
    }
    public startTimer(time: number, cb)
    {
        this.timeout = setTimeout(function () 
        {
            this.doCallback('ERROR: TIMEOUT');
            cb();
        }.bind(this), time);
    }


    toString()  {
        return this.cmd + '\r';
    }
}
