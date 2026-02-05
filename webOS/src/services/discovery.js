import LS2Request from '@enact/webos/LS2Request';

const SERVICE_URI = 'luna://org.moonfin.webos.service';
let subscription = null;
let listeners = [];

export const subscribe = (callback) => {
	listeners.push(callback);

	if (!subscription) {
		subscription = new LS2Request().send({
			service: SERVICE_URI,
			method: 'discover',
			parameters: {},
			subscribe: true,
			onSuccess: (res) => {
				if (res.results) {
					listeners.forEach(cb => cb(Object.values(res.results)));
				}
			},
			onFailure: (err) => {
				console.error('[Discovery] Failed:', err);
			}
		});
	}

	return () => {
		listeners = listeners.filter(cb => cb !== callback);
		if (listeners.length === 0 && subscription) {
			subscription.cancel();
			subscription = null;
		}
	};
};

export const getServers = () => {
	return new Promise((resolve, reject) => {
		new LS2Request().send({
			service: SERVICE_URI,
			method: 'discover',
			parameters: {},
			onSuccess: (res) => {
				resolve(Object.values(res.results || {}));
			},
			onFailure: reject
		});
	});
};
