const DecoAPIWraper = require('./.homeybuild/lib/client').default;
console.log('Imported DecoAPIWraper');
(async () => {
    try {
        const client = new DecoAPIWraper('192.168.0.1');
        console.log('Instantiated client');
        const result = await client.authenticate('password');
        console.log('Authentication result:', result);
    } catch (e) {
        console.error('Crash:', e);
    }
})();
