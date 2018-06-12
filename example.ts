import { Modem } from "./src";
console.log("start");

function onSMS(sms) {
    console.log('onSMS', sms);
}
function onUSSD(ussd) {
    console.log('onUSSD', ussd);
}
function onStatusReport(report) {
    console.log('onStatusReport', report);
}

var modem1 = new Modem({
    port: '/dev/ttyUSB0',
    notify_port: '/dev/ttyUSB1',
    debug: true
});
modem1.on('message', onStatusReport);
modem1.on('report', onStatusReport);
modem1.on('error', (err) => {
    modem1.logger.error(err);
});
modem1.on('USSD', onUSSD);
modem1.logger.fatal("HAHAHA");
modem1.logger.level = "fatal";
modem1.connect(function () {

    setInterval(function () {
        modem1.getSignalStrength((e, d) => {
            if (e)
                console.log(`Signal: ERR: ${e}`)
            else
                console.log(`Signal: ${JSON.stringify(d)}`)
        })
        modem1.getIMEI((e, d) => {
            if (e)
                console.log(`IMEI: ERR: ${e}`)
            else
                console.log(`IMEI: ${d}`)
        })
        modem1.getIMSI((e, d) => {
            if (e)
                console.log(`IMSI: ERR: ${e}`)
            else
                console.log(`IMSI: ${d}`)
        })
        modem1.getUSSD("*100#", (e, d) => {
            if (e)
                console.log(`IMSI: ERR: ${e}`)
            else
                console.log(`IMSI: ${d}`)
        })
    }.bind(this), 10000);

});

