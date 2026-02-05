import {useState, useEffect} from 'react';
import LS2Request from '@enact/webos/LS2Request';

const SERVICE_URI = 'luna://org.moonfin.webos.service';

// Limit cache size to prevent memory bloat
const MAX_CACHE_SIZE = 100;
const imageCache = new Map();

// Simple LRU-like cache management
const addToCache = (url, data) => {
	if (imageCache.size >= MAX_CACHE_SIZE) {
		const keysToDelete = Array.from(imageCache.keys()).slice(0, 20);
		keysToDelete.forEach(key => imageCache.delete(key));
	}
	imageCache.set(url, data);
};

const proxyImage = (url) => {
	return new Promise((resolve) => {
		if (!url || !url.includes('image.tmdb.org')) {
			resolve(url);
			return;
		}

		if (imageCache.has(url)) {
			resolve(imageCache.get(url));
			return;
		}

		new LS2Request().send({
			service: SERVICE_URI,
			method: 'imageProxy',
			parameters: {url},
			onSuccess: (response) => {
				if (response.success && response.data) {
					const dataUrl = `data:${response.contentType || 'image/jpeg'};base64,${response.data}`;
					addToCache(url, dataUrl);
					resolve(dataUrl);
				} else {
					resolve(url);
				}
			},
			onFailure: () => resolve(url)
		});
	});
};

export const useProxiedImage = (originalUrl) => {
	const [imageUrl, setImageUrl] = useState(originalUrl);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let mounted = true;
		setLoading(true);

		if (!originalUrl) {
			setImageUrl(null);
			setLoading(false);
			return;
		}

		if (imageCache.has(originalUrl)) {
			setImageUrl(imageCache.get(originalUrl));
			setLoading(false);
			return;
		}

		proxyImage(originalUrl).then((proxiedUrl) => {
			if (mounted) {
				setImageUrl(proxiedUrl);
				setLoading(false);
			}
		});

		return () => {
			mounted = false;
		};
	}, [originalUrl]);

	return {imageUrl, loading};
};

// Export cache management functions
export const clearProxiedImageCache = () => {
	imageCache.clear();
	console.log('[useProxiedImage] Cache cleared');
};

export default useProxiedImage;
