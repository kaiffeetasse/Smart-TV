import {createContext, useContext, useState, useEffect, useCallback} from 'react';
import * as jellyseerrApi from '../services/jellyseerrApi';
import {getFromStorage, saveToStorage, removeFromStorage} from '../services/storage';

const JellyseerrContext = createContext(null);

export const JellyseerrProvider = ({children}) => {
	const [isEnabled, setIsEnabled] = useState(false);
	const [isAuthenticated, setIsAuthenticated] = useState(false);
	const [isLoading, setIsLoading] = useState(true);
	const [user, setUser] = useState(null);
	const [serverUrl, setServerUrl] = useState(null);

	useEffect(() => {
		const init = async () => {
			try {
				const config = await getFromStorage('jellyseerr');
				if (config?.url && config?.userId) {
					jellyseerrApi.setConfig(config.url, config.userId, config.apiKey);
					setServerUrl(config.url);
					setIsEnabled(true);

					try {
						const userData = await jellyseerrApi.getUser();
						setUser(userData);
						setIsAuthenticated(true);
					} catch (e) {
						// Session expired
					}
				}
			} catch (e) {
				console.error('[Jellyseerr] Init failed:', e);
			} finally {
				setIsLoading(false);
			}
		};
		init();
	}, []);

	const configure = useCallback(async (url, userId, apiKey = null) => {
		jellyseerrApi.setConfig(url, userId, apiKey);
		setServerUrl(url);
		setIsEnabled(true);
		await saveToStorage('jellyseerr', {url, userId, apiKey});
	}, []);

	const login = useCallback(async (email, password) => {
		const result = await jellyseerrApi.login(email, password);
		setUser(result);
		setIsAuthenticated(true);
		return result;
	}, []);

	const loginWithJellyfin = useCallback(async (username, password, jellyfinHost) => {
		const result = await jellyseerrApi.loginWithJellyfin(username, password, jellyfinHost);
		setUser(result);
		setIsAuthenticated(true);
		return result;
	}, []);

	const logout = useCallback(async () => {
		await jellyseerrApi.logout();
		setUser(null);
		setIsAuthenticated(false);
	}, []);

	const disable = useCallback(async () => {
		await jellyseerrApi.clearCookies();
		await removeFromStorage('jellyseerr');
		jellyseerrApi.setConfig(null, null, null);
		setServerUrl(null);
		setUser(null);
		setIsEnabled(false);
		setIsAuthenticated(false);
	}, []);

	return (
		<JellyseerrContext.Provider value={{
			isEnabled,
			isAuthenticated,
			isLoading,
			user,
			serverUrl,
			api: jellyseerrApi,
			configure,
			login,
			loginWithJellyfin,
			logout,
			disable
		}}>
			{children}
		</JellyseerrContext.Provider>
	);
};

export const useJellyseerr = () => {
	const context = useContext(JellyseerrContext);
	if (!context) {
		throw new Error('useJellyseerr must be used within JellyseerrProvider');
	}
	return context;
};
