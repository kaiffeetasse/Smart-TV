/* global webapis */
let cached = null;

export const getDeviceInfo = () => {
	if (cached) return cached;

	cached = {
		platform: 'Tizen',
		appVersion: process.env.REACT_APP_VERSION || '0.0.0',
		userAgent: navigator.userAgent || 'Unknown',
		screenSize: `${window.screen.width}x${window.screen.height}`,
		tvVersion: 'Unknown',
		modelName: 'Unknown'
	};

	try {
		if (typeof webapis !== 'undefined' && webapis.productinfo) {
			if (typeof webapis.productinfo.getModel === 'function') {
				cached.modelName = webapis.productinfo.getModel() || 'Unknown';
			}
			if (typeof webapis.productinfo.getFirmware === 'function') {
				const firmware = webapis.productinfo.getFirmware();
				const match = firmware?.match(/(\d{4})/);
				if (match) {
					const year = parseInt(match[1], 10);
					if (year >= 2024) cached.tvVersion = '8.0';
					else if (year >= 2023) cached.tvVersion = '7.0';
					else if (year >= 2022) cached.tvVersion = '6.5';
					else if (year >= 2021) cached.tvVersion = '6.0';
					else if (year >= 2020) cached.tvVersion = '5.5';
					else if (year >= 2019) cached.tvVersion = '5.0';
					else if (year >= 2018) cached.tvVersion = '4.0';
					else cached.tvVersion = '3.0';
				}
			}
		}
	} catch {
		// Tizen API not available
	}

	return cached;
};
