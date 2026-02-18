import {useState, useEffect, useCallback, useRef, useMemo} from 'react';
import Spotlight from '@enact/spotlight';
import Button from '@enact/sandstone/Button';
import Scroller from '@enact/sandstone/Scroller';
import * as playback from '../../services/playback';
import {
	initTizenAPI, registerAppStateObserver, keepScreenOn,
	avplayOpen, avplayPrepare, avplayPlay, avplayPause,
	avplaySeek, avplayGetCurrentTime, avplayGetDuration, avplayGetState,
	avplaySetListener, avplaySetSpeed, avplaySelectTrack, avplaySetSilentSubtitle,
	avplayGetTracks, avplaySetDisplayMethod, setDisplayWindow, cleanupAVPlay
} from '@moonfin/platform-tizen/video';
import {useSettings} from '../../context/SettingsContext';
import {KEYS, isBackKey} from '../../utils/keys';
import {getImageUrl} from '../../utils/helpers';
import {getServerUrl} from '../../services/jellyfinApi';
import TrickplayPreview from '../../components/TrickplayPreview';
import SubtitleOffsetOverlay from './SubtitleOffsetOverlay';
import SubtitleSettingsOverlay from './SubtitleSettingsOverlay';
import {
	SpottableButton, SpottableDiv, ModalContainer,
	formatTime, formatEndTime, PLAYBACK_RATES, QUALITY_PRESETS, CONTROLS_HIDE_DELAY,
	IconPlay, IconPause, IconRewind, IconForward, IconSubtitle, IconAudio,
	IconChapters, IconPrevious, IconNext, IconSpeed, IconQuality, IconInfo
} from './PlayerConstants';

import css from './TizenPlayer.module.less';

/**
 * AVPlay-based Player component for Samsung Tizen.
 *
 * Uses Samsung's native AVPlay API instead of HTML5 <video> for hardware-accelerated
 * playback. AVPlay renders on a platform multimedia layer BEHIND the web engine;
 * the web layer must be transparent in the video area for the content to show through.
 */
const Player = ({item, initialAudioIndex, initialSubtitleIndex, onEnded, onBack, onPlayNext, audioPlaylist}) => {
	const {settings} = useSettings();

	const [isLoading, setIsLoading] = useState(true);
	const [isBuffering, setIsBuffering] = useState(false);
	const [error, setError] = useState(null);
	const [title, setTitle] = useState('');
	const [subtitle, setSubtitle] = useState('');
	const [playMethod, setPlayMethod] = useState(null);
	const [isPaused, setIsPaused] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [audioStreams, setAudioStreams] = useState([]);
	const [subtitleStreams, setSubtitleStreams] = useState([]);
	const [chapters, setChapters] = useState([]);
	const [selectedAudioIndex, setSelectedAudioIndex] = useState(null);
	const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState(-1);
	const [subtitleTrackEvents, setSubtitleTrackEvents] = useState(null);
	const [subtitleOffset, setSubtitleOffset] = useState(0);
	const [currentSubtitleText, setCurrentSubtitleText] = useState(null);
	const [controlsVisible, setControlsVisible] = useState(false);
	const [activeModal, setActiveModal] = useState(null);
	const [playbackRate, setPlaybackRate] = useState(1);
	const [selectedQuality, setSelectedQuality] = useState(null);
	const [mediaSegments, setMediaSegments] = useState(null);
	const [showSkipIntro, setShowSkipIntro] = useState(false);
	const [showSkipCredits, setShowSkipCredits] = useState(false);
	const [nextEpisode, setNextEpisode] = useState(null);
	const [showNextEpisode, setShowNextEpisode] = useState(false);
	const [nextEpisodeCountdown, setNextEpisodeCountdown] = useState(null);
	const [isSeeking, setIsSeeking] = useState(false);
	const [seekPosition, setSeekPosition] = useState(0);
	const [mediaSourceId, setMediaSourceId] = useState(null);
	const [hasTriedTranscode, setHasTriedTranscode] = useState(false);
	const [focusRow, setFocusRow] = useState('top');
	const [isAudioMode, setIsAudioMode] = useState(false);

	// Audio playlist tracking
	const audioPlaylistIndex = useMemo(() => {
		if (!audioPlaylist || !item) return -1;
		return audioPlaylist.findIndex(t => t.Id === item.Id);
	}, [audioPlaylist, item]);
	const hasNextTrack = audioPlaylist && audioPlaylistIndex >= 0 && audioPlaylistIndex < audioPlaylist.length - 1;
	const hasPrevTrack = audioPlaylist && audioPlaylistIndex > 0;

	const positionRef = useRef(0);
	const playSessionRef = useRef(null);
	const runTimeRef = useRef(0);
	const healthMonitorRef = useRef(null);
	const nextEpisodeTimerRef = useRef(null);
	const hasTriggeredNextEpisodeRef = useRef(false);
	const unregisterAppStateRef = useRef(null);
	const controlsTimeoutRef = useRef(null);
	const timeUpdateIntervalRef = useRef(null);
	const avplayReadyRef = useRef(false);
	// Refs for stable callbacks inside AVPlay listener (avoids stale closures)
	const handleEndedCallbackRef = useRef(null);
	const handleErrorCallbackRef = useRef(null);
	// Ref for time-update logic (reassigned each render to get fresh state)
	const timeUpdateLogicRef = useRef(null);
	// Deferred seek: only execute actual avplaySeek after user stops pressing arrows
	const seekDebounceRef = useRef(null);
	const pendingSeekMsRef = useRef(null);
	const subtitleTimeoutRef = useRef(null);
	const useNativeSubtitleRef = useRef(false);
	// Ref for the Player container DOM element — used to walk up ancestors for transparency
	const playerContainerRef = useRef(null);

	// Shared handler for AVPlay's onsubtitlechange callback
	// setSilentSubtitle(true) hides native render and fires this with embedded subtitle text
	const handleSubtitleChange = useCallback((dur, text, type) => {
		if (useNativeSubtitleRef.current && type !== 1 && type !== '1') {
			if (subtitleTimeoutRef.current) clearTimeout(subtitleTimeoutRef.current);
			setCurrentSubtitleText(text || null);
			if (text && dur > 0) {
				subtitleTimeoutRef.current = setTimeout(() => {
					setCurrentSubtitleText(null);
				}, parseInt(dur, 10));
			}
		}
	}, []);

	const topButtons = useMemo(() => {
		const buttons = [
			{id: 'playPause', icon: isPaused ? <IconPlay /> : <IconPause />, label: isPaused ? 'Play' : 'Pause', action: 'playPause'}
		];
		if (isAudioMode) {
			buttons.unshift(
				{id: 'previous', icon: <IconPrevious />, label: 'Previous', action: 'prevTrack', disabled: !hasPrevTrack}
			);
			buttons.push(
				{id: 'next', icon: <IconNext />, label: 'Next', action: 'nextTrack', disabled: !hasNextTrack}
			);
		} else {
			buttons.push(
				{id: 'rewind', icon: <IconRewind />, label: 'Rewind', action: 'rewind'},
				{id: 'forward', icon: <IconForward />, label: 'Forward', action: 'forward'},
				{id: 'audio', icon: <IconAudio />, label: 'Audio', action: 'audio', disabled: audioStreams.length === 0},
				{id: 'subtitle', icon: <IconSubtitle />, label: 'Subtitles', action: 'subtitle', disabled: subtitleStreams.length === 0}
			);
		}
		return buttons;
	}, [isPaused, audioStreams.length, subtitleStreams.length, isAudioMode, hasNextTrack, hasPrevTrack]);

	const bottomButtons = useMemo(() => {
		if (isAudioMode) {
			return [];
		}
		return [
			{id: 'chapters', icon: <IconChapters />, label: 'Chapters', action: 'chapter', disabled: chapters.length === 0},
			{id: 'previous', icon: <IconPrevious />, label: 'Previous', action: 'previous', disabled: true},
			{id: 'next', icon: <IconNext />, label: 'Next', action: 'next', disabled: !nextEpisode},
			{id: 'speed', icon: <IconSpeed />, label: 'Speed', action: 'speed'},
			{id: 'quality', icon: <IconQuality />, label: 'Quality', action: 'quality'},
			{id: 'info', icon: <IconInfo />, label: 'Info', action: 'info'}
		];
	}, [chapters.length, nextEpisode, isAudioMode]);

	// ==============================
	// AVPlay Time Update Polling
	// ==============================
	// This ref is reassigned every render so the interval always has fresh React state.
	timeUpdateLogicRef.current = () => {
		if (!avplayReadyRef.current) return;
		const state = avplayGetState();
		if (state !== 'PLAYING' && state !== 'PAUSED') return;

		const ms = avplayGetCurrentTime();
		const time = ms / 1000;
		const ticks = Math.floor(ms * 10000);

		setCurrentTime(time);
		positionRef.current = ticks;

		if (healthMonitorRef.current && state === 'PLAYING') {
			healthMonitorRef.current.recordProgress();
		}

		// Update custom subtitle text - match current position to subtitle events
		if (subtitleTrackEvents && subtitleTrackEvents.length > 0) {
			const lookupTicks = ticks - (subtitleOffset * 10000000);
			let foundSubtitle = null;
			for (const event of subtitleTrackEvents) {
				if (lookupTicks >= event.StartPositionTicks && lookupTicks <= event.EndPositionTicks) {
					foundSubtitle = event.Text;
					break;
				}
			}
			setCurrentSubtitleText(foundSubtitle);
		}

		// Check for intro skip
		if (mediaSegments && settings.skipIntro) {
			const {introStart, introEnd, creditsStart} = mediaSegments;

			if (introStart && introEnd) {
				const inIntro = ticks >= introStart && ticks < introEnd;
				setShowSkipIntro(inIntro);
			}

			if (creditsStart && nextEpisode) {
				const inCredits = ticks >= creditsStart;
				if (inCredits) {
					setShowSkipCredits(prev => {
						if (!prev) {
							// Will start countdown via effect
							return true;
						}
						return prev;
					});
				}
			}
		}

		// Near end of video
		if (nextEpisode && runTimeRef.current > 0) {
			const remaining = runTimeRef.current - ticks;
			const nearEnd = remaining < 300000000;
			if (nearEnd && !hasTriggeredNextEpisodeRef.current) {
				setShowNextEpisode(true);
				hasTriggeredNextEpisodeRef.current = true;
			}
		}
	};

	const startTimeUpdatePolling = useCallback(() => {
		if (timeUpdateIntervalRef.current) clearInterval(timeUpdateIntervalRef.current);
		timeUpdateIntervalRef.current = setInterval(() => {
			timeUpdateLogicRef.current?.();
		}, 500);
	}, []);

	const stopTimeUpdatePolling = useCallback(() => {
		if (timeUpdateIntervalRef.current) {
			clearInterval(timeUpdateIntervalRef.current);
			timeUpdateIntervalRef.current = null;
		}
	}, []);

	// ==============================
	// AVPlay Lifecycle Helpers
	// ==============================

	/**
	 * Start AVPlay playback for a given URL.
	 * Stops any existing session, opens the new URL, prepares, and plays.
	 */
	const startAVPlayback = useCallback(async (url, seekPositionTicks = 0) => {
		stopTimeUpdatePolling();
		cleanupAVPlay();
		avplayReadyRef.current = false;

		// Open new URL
		avplayOpen(url);

		// Set display to full screen - AVPlay renders on platform layer behind web
		setDisplayWindow({x: 0, y: 0, width: 1920, height: 1080});
		avplaySetDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');

		// Set AVPlay event listener
		avplaySetListener({
			onbufferingstart: () => { setIsBuffering(true); },
			onbufferingcomplete: () => { setIsBuffering(false); },
			onstreamcompleted: () => { handleEndedCallbackRef.current?.(); },
			onerror: (eventType) => {
				console.error('[Player] AVPlay error:', eventType);
				handleErrorCallbackRef.current?.();
			},
			oncurrentplaytime: () => {},
			onevent: (eventType, eventData) => {
				console.log('[Player] AVPlay event:', eventType, eventData);
			},
			onsubtitlechange: handleSubtitleChange,
			ondrmevent: () => {}
		});

		// Prepare (async)
		await avplayPrepare();
		avplayReadyRef.current = true;

		// Get duration from AVPlay (returns ms)
		const durationMs = avplayGetDuration();
		if (durationMs > 0) {
			setDuration(durationMs / 1000);
		}

		// Seek to position if resuming
		if (seekPositionTicks > 0) {
			const seekMs = Math.floor(seekPositionTicks / 10000);
			await avplaySeek(seekMs);
		}

		// Play
		avplayPlay();
		setIsPaused(false);

		// Start time update polling
		startTimeUpdatePolling();
	}, [startTimeUpdatePolling, stopTimeUpdatePolling, handleSubtitleChange]);

	// ==============================
	// Initialization
	// ==============================
	useEffect(() => {
		const init = async () => {
			await initTizenAPI();
			await keepScreenOn(true);

			// Make ALL ancestor backgrounds transparent so AVPlay video layer shows through.
			// Enact's ThemeDecorator, Panels, and Panel components all inject opaque
			// backgrounds that would otherwise block the native AVPlay layer behind the web engine.
			document.body.style.background = 'transparent';
			document.documentElement.style.background = 'transparent';
			if (playerContainerRef.current) {
				let el = playerContainerRef.current.parentElement;
				while (el && el !== document.documentElement) {
					el.style.background = 'transparent';
					el.style.backgroundColor = 'transparent';
					el = el.parentElement;
				}
			} else {
				// Fallback: target known roots
				const appRoot = document.getElementById('root') || document.getElementById('app');
				if (appRoot) {
					appRoot.style.background = 'transparent';
					// Also walk its children upward from appRoot
					let child = appRoot.firstElementChild;
					while (child) {
						child.style.background = 'transparent';
						child.style.backgroundColor = 'transparent';
						child = child.firstElementChild;
					}
				}
			}

			unregisterAppStateRef.current = registerAppStateObserver(
				() => {
					console.log('[Player] App resumed');
					if (avplayReadyRef.current && !isPaused) {
						const state = avplayGetState();
						if (state === 'PAUSED' || state === 'READY') {
							try { avplayPlay(); } catch (e) { void e; }
						}
					}
				},
				() => {
					console.log('[Player] App backgrounded - pausing and saving progress');
					const state = avplayGetState();
					if (state === 'PLAYING') {
						try { avplayPause(); } catch (e) { void e; }
					}
					if (positionRef.current > 0) {
						playback.reportProgress(positionRef.current);
					}
				}
			);
		};
		init();

		const containerNode = playerContainerRef.current;

		return () => {
			keepScreenOn(false);
			// Restore backgrounds on all ancestors
			document.body.style.background = '';
			document.documentElement.style.background = '';
			if (containerNode) {
				let el = containerNode.parentElement;
				while (el && el !== document.documentElement) {
					el.style.background = '';
					el.style.backgroundColor = '';
					el = el.parentElement;
				}
			} else {
				const appRoot = document.getElementById('root') || document.getElementById('app');
				if (appRoot) appRoot.style.background = '';
			}

			if (unregisterAppStateRef.current) {
				unregisterAppStateRef.current();
			}
		};
	}, [isPaused]);

	// Handle playback health issues
	const handleUnhealthy = useCallback(async () => {
		console.log('[Player] Playback unhealthy, falling back to transcode');
	}, []);

	// ==============================
	// Load Media & Start AVPlay
	// ==============================
	useEffect(() => {
		const loadMedia = async () => {
			setIsLoading(true);
			setError(null);

			// Stop any previous playback
			stopTimeUpdatePolling();
			cleanupAVPlay();
			avplayReadyRef.current = false;

			try {
				const startPosition = item.UserData?.PlaybackPositionTicks || 0;
				const effectiveBitrate = selectedQuality || settings.maxBitrate || undefined;
				const result = await playback.getPlaybackInfo(item.Id, {
					startPositionTicks: startPosition,
					maxBitrate: effectiveBitrate,
					preferTranscode: settings.preferTranscode,
					item: item,
					audioStreamIndex: initialAudioIndex != null ? initialAudioIndex : undefined
				});

				setPlayMethod(result.playMethod);
				setMediaSourceId(result.mediaSourceId);
				playSessionRef.current = result.playSessionId;
				positionRef.current = startPosition;
				runTimeRef.current = result.runTimeTicks || 0;
				setDuration((result.runTimeTicks || 0) / 10000000);

				// Set streams
				setAudioStreams(result.audioStreams || []);
				setSubtitleStreams(result.subtitleStreams || []);

				// Chapters are an Item property, not MediaSource — result.chapters may be empty
				let chapterList = result.chapters || [];
				if (chapterList.length === 0) {
					chapterList = await playback.fetchItemChapters(item.Id, item);
				}
				setChapters(chapterList);

				// Handle initial audio selection
				if (initialAudioIndex !== undefined && initialAudioIndex !== null) {
					setSelectedAudioIndex(initialAudioIndex);
				} else {
					const defaultAudio = result.audioStreams?.find(s => s.isDefault);
					if (defaultAudio) setSelectedAudioIndex(defaultAudio.index);
				}

				// Track pending audio/subtitle setup (apply after AVPlay prepare)
				let pendingAudioIndex = null;
				if (initialAudioIndex != null) {
					pendingAudioIndex = initialAudioIndex;
				}

				let pendingSubAction = null;

				const loadSubtitleData = async (sub) => {
					if (sub && sub.isEmbeddedNative) {
				console.log('[Player] Initial: Using native embedded subtitle (codec:', sub.codec, ')');
						pendingSubAction = {type: 'native', stream: sub};
						setSubtitleTrackEvents(null);
					} else if (sub && sub.isTextBased) {
						pendingSubAction = {type: 'text'};
						try {
							const data = await playback.fetchSubtitleData(sub);
							if (data && data.TrackEvents) {
								setSubtitleTrackEvents(data.TrackEvents);
								console.log('[Player] Loaded', data.TrackEvents.length, 'subtitle events');
							} else {
								setSubtitleTrackEvents(null);
							}
						} catch (err) {
							console.error('[Player] Error fetching subtitle data:', err);
							setSubtitleTrackEvents(null);
						}
					} else {
						pendingSubAction = {type: 'off'};
						setSubtitleTrackEvents(null);
					}
					setCurrentSubtitleText(null);
				};

				if (initialSubtitleIndex !== undefined && initialSubtitleIndex !== null) {
					if (initialSubtitleIndex >= 0) {
						const initialSub = result.subtitleStreams?.find(s => s.index === initialSubtitleIndex);
						if (initialSub) {
							setSelectedSubtitleIndex(initialSubtitleIndex);
							await loadSubtitleData(initialSub);
						}
					} else {
						setSelectedSubtitleIndex(-1);
						setSubtitleTrackEvents(null);
					}
				} else if (settings.subtitleMode === 'always') {
					const defaultSub = result.subtitleStreams?.find(s => s.isDefault);
					if (defaultSub) {
						setSelectedSubtitleIndex(defaultSub.index);
						await loadSubtitleData(defaultSub);
					} else if (result.subtitleStreams?.length > 0) {
						const firstSub = result.subtitleStreams[0];
						setSelectedSubtitleIndex(firstSub.index);
						await loadSubtitleData(firstSub);
					}
				} else if (settings.subtitleMode === 'forced') {
					const forcedSub = result.subtitleStreams?.find(s => s.isForced);
					if (forcedSub) {
						setSelectedSubtitleIndex(forcedSub.index);
						await loadSubtitleData(forcedSub);
					}
				}

				// Build title and subtitle
				let displayTitle = item.Name;
				let displaySubtitle = '';
				if (item.SeriesName) {
					displayTitle = item.SeriesName;
					displaySubtitle = `S${item.ParentIndexNumber}E${item.IndexNumber} - ${item.Name}`;
					} else if (result.isAudio) {
					displayTitle = item.Name;
					displaySubtitle = item.AlbumArtist || item.Artists?.[0] || item.Album || '';
				}
				setTitle(displayTitle);
				setSubtitle(displaySubtitle);
				setIsAudioMode(!!result.isAudio);

				// Audio mode: always show controls, skip video-only features
				if (result.isAudio) {
					setControlsVisible(true);
				} else {
					if (settings.skipIntro) {
						const segments = await playback.getMediaSegments(item.Id);
						setMediaSegments(segments);
					}

					// Load next episode for TV shows
					if (item.Type === 'Episode') {
						const next = await playback.getNextEpisode(item);
						setNextEpisode(next);
					}
				}

				// === Start AVPlay ===
				avplayOpen(result.url);
				setDisplayWindow({x: 0, y: 0, width: 1920, height: 1080});
				avplaySetDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');

				avplaySetListener({
					onbufferingstart: () => { setIsBuffering(true); },
					onbufferingcomplete: () => { setIsBuffering(false); },
					onstreamcompleted: () => { handleEndedCallbackRef.current?.(); },
					onerror: (eventType) => {
						console.error('[Player] AVPlay error:', eventType);
						handleErrorCallbackRef.current?.();
					},
					oncurrentplaytime: () => {},
					onevent: (eventType, eventData) => {
						console.log('[Player] AVPlay event:', eventType, eventData);
					},
					onsubtitlechange: handleSubtitleChange,
				ondrmevent: () => {}
			});

				await avplayPrepare();
				avplayReadyRef.current = true;

				// Get duration from AVPlay (returns ms)
				const durationMs = avplayGetDuration();
				if (durationMs > 0) {
					setDuration(durationMs / 1000);
					runTimeRef.current = Math.floor(durationMs * 10000);
				}

				// Seek to start position if resuming
				if (startPosition > 0) {
					const seekMs = Math.floor(startPosition / 10000);
					await avplaySeek(seekMs);
				}

				// Play — must be called BEFORE setSelectTrack, which requires PLAYING or PAUSED state
				avplayPlay();
				setIsPaused(false);

				// Apply pending track selections (AVPlay must be in PLAYING/PAUSED state)
				const trackInfo = (pendingAudioIndex != null || pendingSubAction) ? avplayGetTracks() : [];
				const allTracks = Array.isArray(trackInfo) ? trackInfo : [];

				if (pendingAudioIndex != null && result.playMethod !== playback.PlayMethod.Transcode) {
					try {
						// Map Jellyfin stream Index → AVPlay audio track index
						const audioTracks = allTracks.filter(t => t.type === 'AUDIO');
						const jellyfinAudioStreams = result.audioStreams || [];
						const jellyfinPos = jellyfinAudioStreams.findIndex(s => s.index === pendingAudioIndex);
						if (jellyfinPos >= 0 && jellyfinPos < audioTracks.length) {
							const tizenAudioIndex = audioTracks[jellyfinPos].index;
							avplaySelectTrack('AUDIO', tizenAudioIndex);
							console.log('[Player] Applied initial audio track via AVPlay, jellyfinIndex:', pendingAudioIndex, 'tizenIndex:', tizenAudioIndex);
						} else if (audioTracks.length > 0) {
							avplaySelectTrack('AUDIO', pendingAudioIndex);
							console.log('[Player] Applied initial audio track via AVPlay (direct), index:', pendingAudioIndex);
						}
					} catch (audioErr) {
						console.warn('[Player] Failed to apply initial audio track:', audioErr.message);
					}
				}

				if (pendingSubAction) {
					if (pendingSubAction.type === 'native' && pendingSubAction.stream) {
						let nativeApplied = false;
						try {
							// Samsung AVPlay API uses 'TEXT' (not 'SUBTITLE') for subtitle tracks
							const subTracks = allTracks.filter(t => t.type === 'TEXT');
							if (subTracks.length > 0) {
								const embeddedStreams = (result.subtitleStreams || []).filter(s => s.isEmbeddedNative);
								const embeddedIndex = embeddedStreams.indexOf(pendingSubAction.stream);
								if (embeddedIndex >= 0 && embeddedIndex < subTracks.length) {
									const tizenIndex = subTracks[embeddedIndex].index;
									avplaySelectTrack('TEXT', tizenIndex);
									// setSilentSubtitle(true) = hide native render + fire onsubtitlechange events
									// setSilentSubtitle(false) = show native render + NO events (per Samsung docs)
									avplaySetSilentSubtitle(true);
									useNativeSubtitleRef.current = true;
									nativeApplied = true;
									console.log('[Player] Applied native embedded subtitle via TEXT track, tizenIndex:', tizenIndex);
								}
							}
						} catch (err) {
							console.warn('[Player] Native subtitle track mapping failed:', err);
						}
						if (!nativeApplied) {
							console.log('[Player] Native subtitle failed, falling back to extraction');
							useNativeSubtitleRef.current = false;
							avplaySetSilentSubtitle(true);
							try {
								const data = await playback.fetchSubtitleData(pendingSubAction.stream);
								if (data && data.TrackEvents) {
									setSubtitleTrackEvents(data.TrackEvents);
									console.log('[Player] Loaded', data.TrackEvents.length, 'subtitle events (fallback)');
								}
							} catch (fetchErr) {
								console.error('[Player] Subtitle extraction fallback failed:', fetchErr);
							}
						}
					} else if (pendingSubAction.type === 'text') {
						avplaySetSilentSubtitle(true);
					} else {
						avplaySetSilentSubtitle(true);
					}
				}

				// Report start and begin progress reporting
				playback.reportStart(positionRef.current);
				playback.startProgressReporting(() => positionRef.current);
				playback.startHealthMonitoring(handleUnhealthy);
				healthMonitorRef.current = playback.getHealthMonitor();

				// Start time update polling
				startTimeUpdatePolling();

				console.log(`[Player] Loaded ${displayTitle} via ${result.playMethod} (AVPlay native)`);
			} catch (err) {
				console.error('[Player] Failed to load media:', err);
				setError(err.message || 'Failed to load media');
			} finally {
				setIsLoading(false);
			}
		};

		loadMedia();

		return () => {
			// Report stop to server with current position
			if (positionRef.current > 0) {
				playback.reportStop(positionRef.current);
			}

			playback.stopProgressReporting();
			playback.stopHealthMonitoring();
			stopTimeUpdatePolling();
			cleanupAVPlay();
			avplayReadyRef.current = false;

			if (nextEpisodeTimerRef.current) {
				clearInterval(nextEpisodeTimerRef.current);
			}
			if (controlsTimeoutRef.current) {
				clearTimeout(controlsTimeoutRef.current);
			}
			if (seekDebounceRef.current) {
				clearTimeout(seekDebounceRef.current);
				seekDebounceRef.current = null;
			}
			if (subtitleTimeoutRef.current) {
				clearTimeout(subtitleTimeoutRef.current);
				subtitleTimeoutRef.current = null;
			}
			useNativeSubtitleRef.current = false;
			pendingSeekMsRef.current = null;
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [item, selectedQuality, settings.maxBitrate, settings.preferTranscode, settings.subtitleMode, settings.skipIntro]);

	// ==============================
	// Controls Auto-hide
	// ==============================
	const showControls = useCallback(() => {
		setControlsVisible(true);
		if (controlsTimeoutRef.current) {
			clearTimeout(controlsTimeoutRef.current);
		}
		// Don't auto-hide controls in audio mode
		if (!isAudioMode) {
			controlsTimeoutRef.current = setTimeout(() => {
				if (!activeModal) {
					setControlsVisible(false);
				}
			}, CONTROLS_HIDE_DELAY);
		}
	}, [activeModal, isAudioMode]);

	const hideControls = useCallback(() => {
		setControlsVisible(false);
		if (controlsTimeoutRef.current) {
			clearTimeout(controlsTimeoutRef.current);
		}
	}, []);

	// Cancel next episode countdown
	const cancelNextEpisodeCountdown = useCallback(() => {
		if (nextEpisodeTimerRef.current) {
			clearInterval(nextEpisodeTimerRef.current);
			nextEpisodeTimerRef.current = null;
		}
		setNextEpisodeCountdown(null);
		setShowNextEpisode(false);
		setShowSkipCredits(false);
	}, []);

	// Play next episode
	const handlePlayNextEpisode = useCallback(async () => {
		if (nextEpisode && onPlayNext) {
			cancelNextEpisodeCountdown();
			stopTimeUpdatePolling();
			await playback.reportStop(positionRef.current);
			cleanupAVPlay();
			avplayReadyRef.current = false;
			onPlayNext(nextEpisode);
		}
	}, [nextEpisode, onPlayNext, cancelNextEpisodeCountdown, stopTimeUpdatePolling]);

	// Audio playlist: next track
	const handleNextTrack = useCallback(async () => {
		if (hasNextTrack && onPlayNext) {
			await playback.reportStop(positionRef.current);
			onPlayNext(audioPlaylist[audioPlaylistIndex + 1]);
		}
	}, [hasNextTrack, onPlayNext, audioPlaylist, audioPlaylistIndex]);

	// Audio playlist: previous track (or restart current if >3s in)
	const handlePrevTrack = useCallback(async () => {
		if (avplayReadyRef.current) {
			const ms = avplayGetCurrentTime();
			if (ms > 3000) {
				// Restart current track
				avplaySeek(0).catch(e => console.warn('[Player] Seek failed:', e));
				return;
			}
		}
		if (hasPrevTrack && onPlayNext) {
			await playback.reportStop(positionRef.current);
			onPlayNext(audioPlaylist[audioPlaylistIndex - 1]);
		}
	}, [hasPrevTrack, onPlayNext, audioPlaylist, audioPlaylistIndex]);

	// Start countdown to next episode
	const startNextEpisodeCountdown = useCallback(() => {
		if (nextEpisodeTimerRef.current) return;

		let countdown = 15;
		setNextEpisodeCountdown(countdown);

		nextEpisodeTimerRef.current = setInterval(() => {
			countdown--;
			setNextEpisodeCountdown(countdown);

			if (countdown <= 0) {
				clearInterval(nextEpisodeTimerRef.current);
				nextEpisodeTimerRef.current = null;
				handlePlayNextEpisode();
			}
		}, 1000);
	}, [handlePlayNextEpisode]);

	useEffect(() => {
		if (showSkipIntro && !activeModal) {
			window.requestAnimationFrame(() => {
				Spotlight.focus('skip-intro-btn');
			});
		}
	}, [showSkipIntro, activeModal]);

	// Start next episode countdown when credits detected
	useEffect(() => {
		if (showSkipCredits && nextEpisode && settings.autoPlay) {
			startNextEpisodeCountdown();
		}
	}, [showSkipCredits, nextEpisode, settings.autoPlay, startNextEpisodeCountdown]);

	// Start next episode countdown when near end
	useEffect(() => {
		if (showNextEpisode && !showSkipCredits && nextEpisode && settings.autoPlay) {
			startNextEpisodeCountdown();
		}
	}, [showNextEpisode, showSkipCredits, nextEpisode, settings.autoPlay, startNextEpisodeCountdown]);

	// ==============================
	// Playback Event Handlers (via AVPlay listener refs)
	// ==============================
	const handleEnded = useCallback(async () => {
		stopTimeUpdatePolling();
		await playback.reportStop(positionRef.current);
		cleanupAVPlay();
		avplayReadyRef.current = false;
		// Auto-advance to next track in audio playlist
		if (hasNextTrack && onPlayNext) {
			onPlayNext(audioPlaylist[audioPlaylistIndex + 1]);
		} else if (nextEpisode && onPlayNext) {
			onPlayNext(nextEpisode);
		} else {
			onEnded?.();
		}
	}, [onEnded, onPlayNext, nextEpisode, stopTimeUpdatePolling, hasNextTrack, audioPlaylist, audioPlaylistIndex]);

	const handleError = useCallback(async () => {
		console.error('[Player] Playback error');

		if (!hasTriedTranscode && playMethod !== playback.PlayMethod.Transcode) {
			console.log('[Player] DirectPlay failed, falling back to transcode...');
			setHasTriedTranscode(true);

			try {
				const result = await playback.getPlaybackInfo(item.Id, {
					startPositionTicks: positionRef.current,
					maxBitrate: selectedQuality || settings.maxBitrate,
					enableDirectPlay: false,
					enableDirectStream: false,
					enableTranscoding: true,
					item: item
				});

				if (result.url) {
					setPlayMethod(result.playMethod);
					playSessionRef.current = result.playSessionId;
					// Restart AVPlay with transcode URL
					try {
						await startAVPlayback(result.url, positionRef.current);
						playback.reportStart(positionRef.current);
						playback.startProgressReporting(() => positionRef.current);
					} catch (restartErr) {
						console.error('[Player] AVPlay restart failed:', restartErr);
						setError('Playback failed. The file format may not be supported.');
					}
					return;
				}
			} catch (fallbackErr) {
				console.error('[Player] Transcode fallback failed:', fallbackErr);
			}
		}

		setError('Playback failed. The file format may not be supported.');
	}, [hasTriedTranscode, playMethod, item, selectedQuality, settings.maxBitrate, startAVPlayback]);

	// Keep callback refs in sync
	handleEndedCallbackRef.current = handleEnded;
	handleErrorCallbackRef.current = handleError;

	// ==============================
	// Control Actions (AVPlay-based)
	// ==============================
	const handleBack = useCallback(async () => {
		cancelNextEpisodeCountdown();
		stopTimeUpdatePolling();
		await playback.reportStop(positionRef.current);
		cleanupAVPlay();
		avplayReadyRef.current = false;
		onBack?.();
	}, [onBack, cancelNextEpisodeCountdown, stopTimeUpdatePolling]);

	const handlePlayPause = useCallback(() => {
		const state = avplayGetState();
		if (state === 'PLAYING') {
			avplayPause();
			setIsPaused(true);
		} else if (state === 'PAUSED' || state === 'READY') {
			avplayPlay();
			setIsPaused(false);
		}
	}, []);

	const handleRewind = useCallback(() => {
		if (!avplayReadyRef.current) return;
		const ms = avplayGetCurrentTime();
		const newMs = Math.max(0, ms - settings.seekStep * 1000);
		avplaySeek(newMs).catch(e => console.warn('[Player] Seek failed:', e));
	}, [settings.seekStep]);

	const handleForward = useCallback(() => {
		if (!avplayReadyRef.current) return;
		const ms = avplayGetCurrentTime();
		const durationMs = avplayGetDuration();
		const newMs = Math.min(durationMs, ms + settings.seekStep * 1000);
		avplaySeek(newMs).catch(e => console.warn('[Player] Seek failed:', e));
	}, [settings.seekStep]);

	const handleSkipIntro = useCallback(() => {
		if (mediaSegments?.introEnd && avplayReadyRef.current) {
			const seekMs = Math.floor(mediaSegments.introEnd / 10000);
			avplaySeek(seekMs).catch(e => console.warn('[Player] Seek failed:', e));
		}
		setShowSkipIntro(false);
	}, [mediaSegments]);

	// Modal handlers
	const openModal = useCallback((modal) => {
		setActiveModal(modal);
		window.requestAnimationFrame(() => {
			const modalId = `${modal}-modal`;

			const focusResult = Spotlight.focus(modalId);

			if (!focusResult) {
				const selectedItem = document.querySelector(`[data-modal="${modal}"] [data-selected="true"]`);
				const firstItem = document.querySelector(`[data-modal="${modal}"] button`);
				if (selectedItem) {
					Spotlight.focus(selectedItem);
				} else if (firstItem) {
					Spotlight.focus(firstItem);
				}
			}
		});
	}, []);

	const closeModal = useCallback(() => {
		setActiveModal(null);
		showControls();
		window.requestAnimationFrame(() => {
			Spotlight.focus('player-controls');
		});
	}, [showControls]);

	// Track selection - using data attributes to avoid arrow functions in JSX
	const handleSelectAudio = useCallback(async (e) => {
		const index = parseInt(e.currentTarget.dataset.index, 10);
		if (isNaN(index)) return;
		setSelectedAudioIndex(index);
		closeModal();

		try {
			// AVPlay: try switching audio track natively first
			if (playMethod !== playback.PlayMethod.Transcode && avplayReadyRef.current) {
				try {
					// Map Jellyfin stream Index to AVPlay's audio track index
					const trackInfo = avplayGetTracks();
					const audioTracks = Array.isArray(trackInfo) ? trackInfo.filter(t => t.type === 'AUDIO') : [];
					const jellyfinPos = audioStreams.findIndex(s => s.index === index);
					if (jellyfinPos >= 0 && jellyfinPos < audioTracks.length) {
						const tizenAudioIndex = audioTracks[jellyfinPos].index;
						avplaySelectTrack('AUDIO', tizenAudioIndex);
						console.log('[Player] Switched audio track natively, jellyfinIndex:', index, 'tizenIndex:', tizenAudioIndex);
						return;
					}
						avplaySelectTrack('AUDIO', index);
					console.log('[Player] Switched audio track natively (direct), index:', index);
					return;
				} catch (nativeErr) {
					console.log('[Player] Native audio switch failed, reloading:', nativeErr.message);
				}
			}

			const currentMs = avplayGetCurrentTime();
			const currentPositionTicks = Math.floor(currentMs * 10000);

			const result = await playback.changeAudioStream(index, currentPositionTicks);
			if (result) {
				console.log('[Player] Switching audio track via stream reload for', playMethod, '- resuming from', currentPositionTicks);
				positionRef.current = currentPositionTicks;
				if (result.playMethod) setPlayMethod(result.playMethod);
				await startAVPlayback(result.url, currentPositionTicks);
				playback.reportStart(positionRef.current);
				playback.startProgressReporting(() => positionRef.current);
			}
		} catch (err) {
			console.error('[Player] Failed to change audio:', err);
		}
	}, [playMethod, closeModal, startAVPlayback, audioStreams]);

	const handleSelectSubtitle = useCallback(async (e) => {
		const index = parseInt(e.currentTarget.dataset.index, 10);
		if (isNaN(index)) return;
		if (index === -1) {
			setSelectedSubtitleIndex(-1);
			setSubtitleTrackEvents(null);
			setCurrentSubtitleText(null);
			useNativeSubtitleRef.current = false;
			if (subtitleTimeoutRef.current) clearTimeout(subtitleTimeoutRef.current);
			avplaySetSilentSubtitle(true);
		} else {
			setSelectedSubtitleIndex(index);
			const stream = subtitleStreams.find(s => s.index === index);

			let nativeSuccess = false;

			if (stream && stream.isEmbeddedNative) {
				try {
					const trackInfo = avplayGetTracks();
					// Samsung AVPlay API uses 'TEXT' (not 'SUBTITLE') for subtitle tracks
					const subTracks = Array.isArray(trackInfo) ? trackInfo.filter(t => t.type === 'TEXT') : [];

					if (subTracks.length > 0) {
						const embeddedStreams = subtitleStreams.filter(s => s.isEmbeddedNative);
						const embeddedIndex = embeddedStreams.indexOf(stream);

						if (embeddedIndex >= 0 && embeddedIndex < subTracks.length) {
							const tizenIndex = subTracks[embeddedIndex].index;
							avplaySelectTrack('TEXT', tizenIndex);
							avplaySetSilentSubtitle(true);
							useNativeSubtitleRef.current = true;
							nativeSuccess = true;
						}
					}
				} catch (err) {
					console.warn('[Player] Error selecting native track:', err);
				}
			}

			if (nativeSuccess) {
				setSubtitleTrackEvents(null);
				setCurrentSubtitleText(null);
			} else if (stream && (stream.isTextBased || stream.isEmbeddedNative)) {
				useNativeSubtitleRef.current = false;
				avplaySetSilentSubtitle(true);
				try {
					const data = await playback.fetchSubtitleData(stream);
					if (data && data.TrackEvents) {
						setSubtitleTrackEvents(data.TrackEvents);
						console.log('[Player] Loaded', data.TrackEvents.length, 'subtitle events (Fallback/Extracted)');
					} else {
						setSubtitleTrackEvents(null);
					}
				} catch (err) {
					console.error('[Player] Error fetching subtitle data:', err);
					setSubtitleTrackEvents(null);
				}
			} else {
				console.log('[Player] Image-based subtitle (codec:', stream?.codec, ') - requires burn-in via transcode');
				avplaySetSilentSubtitle(true);
				setSubtitleTrackEvents(null);
			}
			setCurrentSubtitleText(null);
		}
		closeModal();
	}, [subtitleStreams, closeModal]);

	const handleSelectSpeed = useCallback((e) => {
		const rate = parseFloat(e.currentTarget.dataset.rate);
		if (isNaN(rate)) return;
		setPlaybackRate(rate);
		// AVPlay supports integer speeds (1, 2, 4); fractional may not work
		if (avplayReadyRef.current) {
			avplaySetSpeed(rate);
		}
		closeModal();
	}, [closeModal]);

	const handleSelectQuality = useCallback((e) => {
		const valueStr = e.currentTarget.dataset.value;
		const value = valueStr === 'null' ? null : parseInt(valueStr, 10);
		setSelectedQuality(isNaN(value) ? null : value);
		closeModal();
	}, [closeModal]);

	const handleSelectChapter = useCallback((e) => {
		const ticks = parseInt(e.currentTarget.dataset.ticks, 10);
		if (isNaN(ticks)) return;
		if (avplayReadyRef.current && ticks >= 0) {
			const seekMs = Math.floor(ticks / 10000);
			avplaySeek(seekMs).catch(err => console.warn('[Player] Chapter seek failed:', err));
		}
		closeModal();
	}, [closeModal]);

	// Progress bar seeking
	const handleProgressClick = useCallback((e) => {
		if (!avplayReadyRef.current) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const percent = (e.clientX - rect.left) / rect.width;
		const newTimeMs = percent * duration * 1000;
		avplaySeek(newTimeMs).catch(err => console.warn('[Player] Seek failed:', err));
	}, [duration]);

	// Deferred seek helpers: only execute the actual avplaySeek after the user
	// stops pressing arrow keys (debounce) or presses OK/Enter to confirm.
	const executeDeferredSeek = useCallback(() => {
		if (seekDebounceRef.current) {
			clearTimeout(seekDebounceRef.current);
			seekDebounceRef.current = null;
		}
		if (pendingSeekMsRef.current != null && avplayReadyRef.current) {
			const seekMs = pendingSeekMsRef.current;
			pendingSeekMsRef.current = null;
			avplaySeek(seekMs).catch(err => console.warn('[Player] Deferred seek failed:', err));
		}
	}, []);

	const scheduleDeferredSeek = useCallback((targetMs) => {
		pendingSeekMsRef.current = targetMs;
		if (seekDebounceRef.current) {
			clearTimeout(seekDebounceRef.current);
		}
		seekDebounceRef.current = setTimeout(() => {
			seekDebounceRef.current = null;
			executeDeferredSeek();
		}, 500);
	}, [executeDeferredSeek]);

	// Progress bar keyboard control — deferred seeking
	const handleProgressKeyDown = useCallback((e) => {
		if (!avplayReadyRef.current) return;
		showControls();
		const step = settings.seekStep;

		if (e.key === 'ArrowLeft' || e.keyCode === 37) {
			e.preventDefault();
			setIsSeeking(true);
			// Use pending position if user is still seeking, otherwise use current AVPlay time
			const baseMs = pendingSeekMsRef.current != null ? pendingSeekMsRef.current : avplayGetCurrentTime();
			const newMs = Math.max(0, baseMs - step * 1000);
			setSeekPosition(Math.floor(newMs * 10000));
			scheduleDeferredSeek(newMs);
		} else if (e.key === 'ArrowRight' || e.keyCode === 39) {
			e.preventDefault();
			setIsSeeking(true);
			const baseMs = pendingSeekMsRef.current != null ? pendingSeekMsRef.current : avplayGetCurrentTime();
			const durationMs = avplayGetDuration();
			const newMs = Math.min(durationMs, baseMs + step * 1000);
			setSeekPosition(Math.floor(newMs * 10000));
			scheduleDeferredSeek(newMs);
		} else if (e.key === 'Enter' || e.keyCode === 13) {
			e.preventDefault();
			executeDeferredSeek();
			setIsSeeking(false);
		} else if (e.key === 'ArrowUp' || e.keyCode === 38) {
			e.preventDefault();
			executeDeferredSeek();
			setFocusRow('top');
			setIsSeeking(false);
		} else if (e.key === 'ArrowDown' || e.keyCode === 40) {
			e.preventDefault();
			executeDeferredSeek();
			setFocusRow('bottom');
			setIsSeeking(false);
		}
	}, [settings.seekStep, showControls, scheduleDeferredSeek, executeDeferredSeek]); // eslint-disable-line react-hooks/exhaustive-deps

	const handleProgressBlur = useCallback(() => {
		executeDeferredSeek();
		setIsSeeking(false);
	}, [executeDeferredSeek]);

	// Button action handler
	const handleButtonAction = useCallback((action) => {
		showControls();
		switch (action) {
			case 'playPause': handlePlayPause(); break;
			case 'rewind': handleRewind(); break;
			case 'forward': handleForward(); break;
			case 'audio': openModal('audio'); break;
			case 'subtitle': openModal('subtitle'); break;
			case 'speed': openModal('speed'); break;
			case 'quality': openModal('quality'); break;
			case 'chapter': openModal('chapter'); break;
			case 'info': openModal('info'); break;
			case 'next': handlePlayNextEpisode(); break;
			case 'nextTrack': handleNextTrack(); break;
			case 'prevTrack': handlePrevTrack(); break;
			default: break;
		}
	}, [showControls, handlePlayPause, handleRewind, handleForward, openModal, handlePlayNextEpisode, handleNextTrack, handlePrevTrack]);

	// Wrapper for control button clicks - reads action from data attribute
	const handleControlButtonClick = useCallback((e) => {
		const action = e.currentTarget.dataset.action;
		if (action) {
			handleButtonAction(action);
		}
	}, [handleButtonAction]);

	const handleSubtitleOffsetChange = useCallback((newOffset) => {
		setSubtitleOffset(newOffset);
	}, []);

	// Prevent propagation handler for modals
	const stopPropagation = useCallback((e) => {
		e.stopPropagation();
	}, []);

	// Extracted handlers for subtitle modal navigation
	const handleSubtitleItemKeyDown = useCallback((e) => {
		if (e.keyCode === 39) { // Right -> Appearance
			e.preventDefault();
			e.stopPropagation();
			Spotlight.focus('btn-subtitle-appearance');
		} else if (e.keyCode === 37) { // Left -> Offset
			e.preventDefault();
			e.stopPropagation();
			Spotlight.focus('btn-subtitle-offset');
		}
	}, []);

	const handleOpenSubtitleOffset = useCallback(() => openModal('subtitleOffset'), [openModal]);
	const handleOpenSubtitleSettings = useCallback(() => openModal('subtitleSettings'), [openModal]);

	// ==============================
	// Global Key Handler
	// ==============================
	useEffect(() => {
		const handleKeyDown = (e) => {
			const key = e.key || e.keyCode;

			// Media playback keys (Tizen remote)
			if (e.keyCode === KEYS.PLAY) {
				e.preventDefault();
				e.stopPropagation();
				showControls();
				const state = avplayGetState();
				if (state === 'PAUSED' || state === 'READY') {
					avplayPlay();
					setIsPaused(false);
				}
				return;
			}
			if (e.keyCode === KEYS.PAUSE) {
				e.preventDefault();
				e.stopPropagation();
				showControls();
				const state = avplayGetState();
				if (state === 'PLAYING') {
					avplayPause();
					setIsPaused(true);
				}
				return;
			}
			if (e.keyCode === KEYS.PLAY_PAUSE) {
				e.preventDefault();
				e.stopPropagation();
				showControls();
				handlePlayPause();
				return;
			}
			if (e.keyCode === KEYS.FAST_FORWARD) {
				e.preventDefault();
				e.stopPropagation();
				handleForward();
				showControls();
				return;
			}
			if (e.keyCode === KEYS.REWIND) {
				e.preventDefault();
				e.stopPropagation();
				handleRewind();
				showControls();
				return;
			}
			if (e.keyCode === KEYS.STOP) {
				e.preventDefault();
				e.stopPropagation();
				handleBack();
				return;
			}

			// Back button
			if (isBackKey(e) || key === 'GoBack' || key === 'Backspace') {
				e.preventDefault();
				e.stopPropagation();
				if (activeModal) {
					closeModal();
					return;
				}
				if (controlsVisible) {
					hideControls();
					return;
				}
				handleBack();
				return;
			}

			// Left/Right when controls hidden -> show controls and focus on seekbar
			if (!controlsVisible && !activeModal) {
				if (key === 'ArrowLeft' || e.keyCode === 37 || key === 'ArrowRight' || e.keyCode === 39) {
					e.preventDefault();
					showControls();
					setFocusRow('progress');
					setIsSeeking(true);
					const ms = avplayGetCurrentTime();
					setSeekPosition(Math.floor(ms * 10000));
					// Apply deferred seek step
					const step = settings.seekStep;
					if (key === 'ArrowLeft' || e.keyCode === 37) {
						const newMs = Math.max(0, ms - step * 1000);
						setSeekPosition(Math.floor(newMs * 10000));
						scheduleDeferredSeek(newMs);
					} else {
						const durationMs = avplayGetDuration();
						const newMs = Math.min(durationMs, ms + step * 1000);
						setSeekPosition(Math.floor(newMs * 10000));
						scheduleDeferredSeek(newMs);
					}
					return;
				}
				// Any other key shows controls
				e.preventDefault();
				showControls();
				return;
			}

			// Up/Down arrow navigation between rows when controls are visible
			if (controlsVisible && !activeModal) {
				showControls(); // Reset timer on navigation

				if (key === 'ArrowUp' || e.keyCode === 38) {
					e.preventDefault();
					setFocusRow(prev => {
						if (prev === 'bottom') return 'progress';
						if (prev === 'progress') return 'top';
						return 'top';
					});
					return;
				}
				if (key === 'ArrowDown' || e.keyCode === 40) {
					e.preventDefault();
					setFocusRow(prev => {
						if (prev === 'top') return 'progress';
						if (prev === 'progress') return bottomButtons.length > 0 ? 'bottom' : 'progress';
						return 'bottom'; // Already at bottom, stay there
					});
					return;
				}
			}

			// Play/Pause with Enter when controls not focused
			if ((key === 'Enter' || e.keyCode === 13) && !controlsVisible && !activeModal) {
				handlePlayPause();
				return;
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [controlsVisible, activeModal, closeModal, hideControls, handleBack, showControls, handlePlayPause, handleForward, handleRewind, currentTime, duration, settings.seekStep, showNextEpisode, showSkipCredits, nextEpisode, cancelNextEpisodeCountdown, bottomButtons.length, scheduleDeferredSeek]);

	// Calculate progress - use seekPosition when actively seeking for smooth scrubbing
	const displayTime = isSeeking ? (seekPosition / 10000000) : currentTime;
	const progressPercent = duration > 0 ? (displayTime / duration) * 100 : 0;

	// Focus appropriate element when focusRow changes
	useEffect(() => {
		if (!controlsVisible) return;

		const timer = setTimeout(() => {
			if (focusRow === 'progress') {
				Spotlight.focus('progress-bar');
			} else if (focusRow === 'bottom') {
				Spotlight.focus('bottom-row-default');
			}
		}, 50);

		return () => clearTimeout(timer);
	}, [focusRow, controlsVisible]);

	// ==============================
	// Render
	// ==============================

	// Render loading
	if (isLoading) {
		return (
			<div className={css.container}>
				<div className={css.loadingIndicator}>
					<div className={css.spinner} />
					<p>Loading...</p>
				</div>
			</div>
		);
	}

	// Render error
	if (error) {
		return (
			<div className={css.container}>
				<div className={css.error}>
					<h2>Playback Error</h2>
					<p>{error}</p>
					<Button onClick={onBack}>Go Back</Button>
				</div>
			</div>
		);
	}

	return (
		<div className={css.container} ref={playerContainerRef} onClick={showControls}>
			{/*
			 * No <video> element - AVPlay renders on the platform multimedia layer
			 * behind the web engine. The container is transparent so video shows through.
			 */}

			{/* Audio Mode: Album Art + Info */}
			{isAudioMode && (
				<div className={css.audioModeBackground}>
					<div className={css.audioModeContent}>
						<div className={css.audioAlbumArt}>
							{item.ImageTags?.Primary ? (
								<img
									src={getImageUrl(item._serverUrl || getServerUrl(), item.Id, 'Primary', {maxHeight: 500, quality: 90})}
									alt={item.Name}
									className={css.audioAlbumImg}
								/>
							) : item.AlbumId && item.AlbumPrimaryImageTag ? (
								<img
									src={getImageUrl(item._serverUrl || getServerUrl(), item.AlbumId, 'Primary', {maxHeight: 500, quality: 90})}
									alt={item.Album || item.Name}
									className={css.audioAlbumImg}
								/>
							) : (
								<div className={css.audioAlbumPlaceholder}>
									<svg viewBox="0 -960 960 960" fill="currentColor" width="120" height="120">
										<path d="M400-120q-66 0-113-47t-47-113q0-66 47-113t113-47q23 0 42.5 5.5T480-418v-422h240v160H560v400q0 66-47 113t-113 47Z"/>
									</svg>
								</div>
							)}
						</div>
						<div className={css.audioTrackInfo}>
							<h1 className={css.audioTrackTitle}>{title}</h1>
							{subtitle && <p className={css.audioTrackArtist}>{subtitle}</p>}
							{item.Album && <p className={css.audioTrackAlbum}>{item.Album}</p>}
						</div>
					</div>
				</div>
			)}

			{/* Custom Subtitle Overlay - rendered on web layer above AVPlay video */}
			{currentSubtitleText && !isAudioMode && (
				<div
					className={css.subtitleOverlay}
					style={{
						bottom: settings.subtitlePosition === 'absolute'
							? `${100 - settings.subtitlePositionAbsolute}%`
							: `${settings.subtitlePosition === 'bottom' ? 10 : settings.subtitlePosition === 'lower' ? 20 : settings.subtitlePosition === 'middle' ? 30 : 40}%`,
						opacity: (settings.subtitleOpacity || 100) / 100
					}}
				>
				{/* eslint-disable react/no-danger */}
					<div
						className={css.subtitleText}
						style={{
							fontSize: `${settings.subtitleSize === 'small' ? 36 : settings.subtitleSize === 'medium' ? 44 : settings.subtitleSize === 'large' ? 52 : 60}px`,
							backgroundColor: `${settings.subtitleBackgroundColor || '#000000'}${Math.round(((settings.subtitleBackground !== undefined ? settings.subtitleBackground : 75) / 100) * 255).toString(16).padStart(2, '0')}`,
							color: settings.subtitleColor || '#ffffff',
							textShadow: `0 0 ${settings.subtitleShadowBlur || 0.1}em ${settings.subtitleShadowColor || '#000000'}${Math.round(((settings.subtitleShadowOpacity !== undefined ? settings.subtitleShadowOpacity : 50) / 100) * 255).toString(16).padStart(2, '0')}`
						}}
						dangerouslySetInnerHTML={{
							__html: currentSubtitleText
								.replace(/\\N/gi, '<br/>')
								.replace(/\r?\n/gi, '<br/>')
								.replace(/{\\.*?}/gi, '') // Remove ASS/SSA style tags
						}}
					/>
					{/* eslint-enable react/no-danger */}
				</div>
			)}

			{/* Video Dimmer - not needed for audio */}
			{!isAudioMode && <div className={`${css.videoDimmer} ${controlsVisible ? css.visible : ''}`} />}

			{/* Buffering Indicator */}
			{isBuffering && (
				<div className={css.bufferingIndicator}>
					<div className={css.spinner} />
				</div>
			)}

			{/* Playback Indicators */}
			{playbackRate !== 1 && (
				<div className={css.playbackIndicators}>
					<div className={css.speedIndicator}>{playbackRate}x</div>
				</div>
			)}

			{/* Skip Intro Button */}
			{showSkipIntro && !isAudioMode && !activeModal && (
				<div className={css.skipOverlay}>
					<SpottableButton className={css.skipButton} onClick={handleSkipIntro} spotlightId="skip-intro-btn">
						Skip Intro
					</SpottableButton>
				</div>
			)}

			{/* Next Episode Overlay */}
			{(showSkipCredits || showNextEpisode) && nextEpisode && !isAudioMode && !activeModal && (
				<div className={css.nextEpisodeOverlay}>
					<div className={css.nextLabel}>Up Next</div>
					<div className={css.nextTitle}>{nextEpisode.Name}</div>
					{nextEpisode.SeriesName && (
						<div className={css.nextMeta}>
							S{nextEpisode.ParentIndexNumber}E{nextEpisode.IndexNumber}
						</div>
					)}
					{nextEpisodeCountdown !== null && (
						<div className={css.nextCountdown}>
							Starting in {nextEpisodeCountdown}s
						</div>
					)}
					<div className={css.nextButtons}>
						<Button onClick={handlePlayNextEpisode}>Play Now</Button>
						<Button onClick={cancelNextEpisodeCountdown}>Hide</Button>
					</div>
				</div>
			)}

			{/* Player Controls Overlay */}
			<div className={`${css.playerControls} ${controlsVisible && !activeModal ? css.visible : ''} ${isAudioMode ? css.audioControls : ''}`}>
				{/* Top - Media Info (hidden in audio mode, shown in album art area instead) */}
				{!isAudioMode && (
				<div className={css.controlsTop}>
					<div className={css.mediaInfo}>
						<h1 className={css.mediaTitle}>{title}</h1>
						{subtitle && <p className={css.mediaSubtitle}>{subtitle}</p>}
					</div>
				</div>
				)}

				{/* Bottom - Controls */}
				<div className={css.controlsBottom}>
					{/* Top Row Buttons */}
					<div className={css.controlButtons}>
						{topButtons.map((btn) => (
							<SpottableButton
								key={btn.id}
								className={`${css.controlBtn} ${btn.disabled ? css.controlBtnDisabled : ''}`}
								data-action={btn.action}
								onClick={btn.disabled ? undefined : handleControlButtonClick}
								aria-label={btn.label}
								aria-disabled={btn.disabled}
								spotlightDisabled={focusRow !== 'top'}
							>
								{btn.icon}
							</SpottableButton>
						))}
					</div>

					{/* Progress Bar */}
					<div className={css.progressContainer}>
						<div className={css.timeInfoTop}>
							<span className={css.timeEnd}>{formatEndTime(duration - displayTime)}</span>
						</div>
						<SpottableDiv
							className={css.progressBar}
							onClick={handleProgressClick}
							onKeyDown={handleProgressKeyDown}
							onBlur={handleProgressBlur}
							tabIndex={0}
							spotlightDisabled={focusRow !== 'progress'}
							spotlightId="progress-bar"
						>
							<div className={css.progressFill} style={{width: `${progressPercent}%`}} />
							<div className={css.seekIndicator} style={{left: `${progressPercent}%`}} />
							{isSeeking && !isAudioMode && (
								<TrickplayPreview
									itemId={item.Id}
									mediaSourceId={mediaSourceId}
									positionTicks={seekPosition}
									visible
									style={{left: `${progressPercent}%`}}
								/>
							)}
						</SpottableDiv>
						<div className={css.timeInfo}>
							<span className={css.timeDisplay}>
								{formatTime(displayTime)} / {formatTime(duration)}
							</span>
						</div>
					</div>

					{/* Bottom Row Buttons */}
					{bottomButtons.length > 0 && (
					<div className={css.controlButtonsBottom}>
						{bottomButtons.map((btn) => (
							<SpottableButton
								key={btn.id}
								className={`${css.controlBtn} ${btn.disabled ? css.controlBtnDisabled : ''}`}
								data-action={btn.action}
								onClick={btn.disabled ? undefined : handleControlButtonClick}
								aria-label={btn.label}
								aria-disabled={btn.disabled}
								spotlightDisabled={focusRow !== 'bottom'}
								spotlightId={btn.id === 'chapters' ? 'bottom-row-default' : undefined}
							>
								{btn.icon}
							</SpottableButton>
						))}
					</div>
					)}
				</div>
			</div>

			{/* Audio Track Modal */}
			{activeModal === 'audio' && (
				<div className={css.trackModal} onClick={closeModal}>
					<ModalContainer className={css.modalContent} onClick={stopPropagation} data-modal="audio" spotlightId="audio-modal">
						<h2 className={css.modalTitle}>Select Audio Track</h2>
						<div className={css.trackList}>
							{audioStreams.map((stream) => (
								<SpottableButton
									key={stream.index}
									className={`${css.trackItem} ${stream.index === selectedAudioIndex ? css.selected : ''}`}
									data-index={stream.index}
									data-selected={stream.index === selectedAudioIndex ? 'true' : undefined}
									onClick={handleSelectAudio}
								>
									<span className={css.trackName}>{stream.displayTitle}</span>
									{stream.channels && <span className={css.trackInfo}>{stream.channels}ch</span>}
								</SpottableButton>
							))}
						</div>
						<p className={css.modalFooter}>Press BACK to close</p>
					</ModalContainer>
				</div>
			)}

			{/* Subtitle Modal */}
			{activeModal === 'subtitle' && (
				<div className={css.trackModal} onClick={closeModal}>
					<ModalContainer className={css.modalContent} onClick={stopPropagation} data-modal="subtitle" spotlightId="subtitle-modal">
						<h2 className={css.modalTitle}>Select Subtitle</h2>
						<div className={css.trackList}>
							<SpottableButton
								className={`${css.trackItem} ${selectedSubtitleIndex === -1 ? css.selected : ''}`}
								data-index={-1}
								data-selected={selectedSubtitleIndex === -1 ? 'true' : undefined}
								onClick={handleSelectSubtitle}
								onKeyDown={handleSubtitleItemKeyDown}
							>
								<span className={css.trackName}>Off</span>
							</SpottableButton>
							{subtitleStreams.map((stream) => (
								<SpottableButton
									key={stream.index}
									className={`${css.trackItem} ${stream.index === selectedSubtitleIndex ? css.selected : ''}`}
									data-index={stream.index}
									data-selected={stream.index === selectedSubtitleIndex ? 'true' : undefined}
									onClick={handleSelectSubtitle}
									onKeyDown={handleSubtitleItemKeyDown}
								>
									<span className={css.trackName}>{stream.displayTitle}</span>
									{stream.isForced && <span className={css.trackInfo}>Forced</span>}
								</SpottableButton>
							))}
						</div>
						<p className={css.modalFooter}>
							<SpottableButton spotlightId="btn-subtitle-offset" className={css.actionBtn} onClick={handleOpenSubtitleOffset}>Offset</SpottableButton>
							<SpottableButton spotlightId="btn-subtitle-appearance" className={css.actionBtn} onClick={handleOpenSubtitleSettings} style={{marginLeft: 15}}>Appearance</SpottableButton>
						</p>
						<p className={css.modalFooter} style={{marginTop: 5, fontSize: 14, opacity: 0.5}}>Press BACK to close</p>
					</ModalContainer>
				</div>
			)}

			{/* Speed Modal */}
			{activeModal === 'speed' && (
				<div className={css.trackModal} onClick={closeModal}>
					<ModalContainer className={css.modalContent} onClick={stopPropagation} data-modal="speed" spotlightId="speed-modal">
						<h2 className={css.modalTitle}>Playback Speed</h2>
						<div className={css.trackList}>
							{PLAYBACK_RATES.map((rate) => (
								<SpottableButton
									key={rate}
									className={`${css.trackItem} ${rate === playbackRate ? css.selected : ''}`}
									data-rate={rate}
									data-selected={rate === playbackRate ? 'true' : undefined}
									onClick={handleSelectSpeed}
								>
									<span className={css.trackName}>{rate === 1 ? 'Normal' : `${rate}x`}</span>
								</SpottableButton>
							))}
						</div>
						<p className={css.modalFooter}>Press BACK to close</p>
					</ModalContainer>
				</div>
			)}

			{/* Quality Modal */}
			{activeModal === 'quality' && (
				<div className={css.trackModal} onClick={closeModal}>
					<ModalContainer className={css.modalContent} onClick={stopPropagation} data-modal="quality" spotlightId="quality-modal">
						<h2 className={css.modalTitle}>Max Bitrate</h2>
						<div className={css.trackList}>
							{QUALITY_PRESETS.map((preset) => (
								<SpottableButton
									key={preset.label}
									className={`${css.trackItem} ${selectedQuality === preset.value ? css.selected : ''}`}
									data-value={preset.value === null ? 'null' : preset.value}
									data-selected={selectedQuality === preset.value ? 'true' : undefined}
									onClick={handleSelectQuality}
								>
									<span className={css.trackName}>{preset.label}</span>
								</SpottableButton>
							))}
						</div>
						<p className={css.modalFooter}>Current: {playMethod || 'Unknown'}</p>
					</ModalContainer>
				</div>
			)}

			{/* Chapter Modal */}
			{activeModal === 'chapter' && (
				<div className={css.trackModal} onClick={closeModal}>
					<ModalContainer className={`${css.modalContent} ${css.chaptersModal}`} onClick={stopPropagation} data-modal="chapter" spotlightId="chapter-modal">
						<h2 className={css.modalTitle}>Chapters</h2>
						<div className={css.trackList}>
							{chapters.map((chapter) => {
								const chapterTime = chapter.startPositionTicks / 10000000;
								const isCurrent = currentTime >= chapterTime &&
									(chapters.indexOf(chapter) === chapters.length - 1 ||
									 currentTime < chapters[chapters.indexOf(chapter) + 1].startPositionTicks / 10000000);
								return (
									<SpottableButton
										key={chapter.index}
										className={`${css.chapterItem} ${isCurrent ? css.currentChapter : ''}`}
										data-ticks={chapter.startPositionTicks}
										data-selected={isCurrent ? 'true' : undefined}
										onClick={handleSelectChapter}
									>
										<span className={css.chapterTime}>{formatTime(chapterTime)}</span>
										<span className={css.chapterName}>{chapter.name}</span>
									</SpottableButton>
								);
							})}
						</div>
						<p className={css.modalFooter}>Press BACK to close</p>
					</ModalContainer>
				</div>
			)}

			{/* Info Modal */}
			{activeModal === 'info' && (() => {
				const session = playback.getCurrentSession();
				const mediaSource = session?.mediaSource;
				const videoStream = mediaSource?.MediaStreams?.find(s => s.Type === 'Video');
				const audioStream = mediaSource?.MediaStreams?.find(s => s.Index === selectedAudioIndex) ||
					mediaSource?.MediaStreams?.find(s => s.Type === 'Audio');
				const subtitleStream = selectedSubtitleIndex >= 0
					? mediaSource?.MediaStreams?.find(s => s.Index === selectedSubtitleIndex)
					: null;

				// Format bitrate nicely
				const formatBitrate = (bitrate) => {
					if (!bitrate) return 'Unknown';
					if (bitrate >= 1000000) return `${(bitrate / 1000000).toFixed(1)} Mbps`;
					if (bitrate >= 1000) return `${(bitrate / 1000).toFixed(0)} Kbps`;
					return `${bitrate} bps`;
				};

				// Get HDR type
				const getHdrType = () => {
					if (!videoStream) return 'SDR';
					const rangeType = videoStream.VideoRangeType || '';
					if (rangeType.includes('DOVI') || rangeType.includes('DoVi')) return 'Dolby Vision';
					if (rangeType.includes('HDR10Plus') || rangeType.includes('HDR10+')) return 'HDR10+';
					if (rangeType.includes('HDR10') || rangeType.includes('HDR')) return 'HDR10';
					if (rangeType.includes('HLG')) return 'HLG';
					if (videoStream.VideoRange === 'HDR') return 'HDR';
					return 'SDR';
				};

				// Get video codec with profile
				const getVideoCodec = () => {
					if (!videoStream) return 'Unknown';
					let codec = (videoStream.Codec || '').toUpperCase();
					if (codec === 'HEVC') codec = 'HEVC (H.265)';
					else if (codec === 'H264' || codec === 'AVC') codec = 'AVC (H.264)';
					else if (codec === 'AV1') codec = 'AV1';
					else if (codec === 'VP9') codec = 'VP9';

					if (videoStream.Profile) {
						codec += ` ${videoStream.Profile}`;
					}
					if (videoStream.Level) {
						codec += `@L${videoStream.Level}`;
					}
					return codec;
				};

				// Get audio codec with channels
				const getAudioCodec = () => {
					if (!audioStream) return 'Unknown';
					let codec = (audioStream.Codec || '').toUpperCase();
					if (codec === 'EAC3') codec = 'E-AC3 (Dolby Digital Plus)';
					else if (codec === 'AC3') codec = 'AC3 (Dolby Digital)';
					else if (codec === 'TRUEHD') codec = 'TrueHD';
					else if (codec === 'DTS') codec = 'DTS';
					else if (codec === 'AAC') codec = 'AAC';
					else if (codec === 'FLAC') codec = 'FLAC';

					return codec;
				};

				const getAudioChannels = () => {
					if (!audioStream) return 'Unknown';
					const channels = audioStream.Channels;
					if (!channels) return 'Unknown';
					if (channels === 8) return '7.1';
					if (channels === 6) return '5.1';
					if (channels === 2) return 'Stereo';
					if (channels === 1) return 'Mono';
					return `${channels} channels`;
				};

				return (
					<div className={css.trackModal} onClick={closeModal}>
						<div className={`${css.modalContent} ${css.videoInfoModal}`} onClick={stopPropagation}>
							<h2 className={css.modalTitle}>Playback Information</h2>
							<Scroller
								className={css.videoInfoContent}
								direction="vertical"
								horizontalScrollbar="hidden"
								verticalScrollbar="hidden"
							>
								{/* Playback Section */}
								<SpottableDiv className={css.infoSection} spotlightId="info-playback">
									<h3 className={css.infoHeader}>Playback</h3>
									<div className={`${css.infoRow} ${css.infoHighlight}`}>
										<span className={css.infoLabel}>Play Method</span>
										<span className={css.infoValue}>{playMethod || 'Unknown'}</span>
									</div>
									<div className={css.infoRow}>
										<span className={css.infoLabel}>Player</span>
										<span className={css.infoValue}>AVPlay (Native)</span>
									</div>
									<div className={css.infoRow}>
										<span className={css.infoLabel}>Container</span>
										<span className={css.infoValue}>
											{(mediaSource?.Container || 'Unknown').toUpperCase()}
										</span>
									</div>
									<div className={css.infoRow}>
										<span className={css.infoLabel}>Bitrate</span>
										<span className={css.infoValue}>
											{formatBitrate(mediaSource?.Bitrate)}
										</span>
									</div>
								</SpottableDiv>

								{/* Video Section */}
								{videoStream && (
									<SpottableDiv className={css.infoSection} spotlightId="info-video">
										<h3 className={css.infoHeader}>Video</h3>
										<div className={css.infoRow}>
											<span className={css.infoLabel}>Resolution</span>
											<span className={css.infoValue}>
												{videoStream.Width}×{videoStream.Height}
												{videoStream.RealFrameRate && ` @ ${Math.round(videoStream.RealFrameRate)}fps`}
											</span>
										</div>
										<div className={css.infoRow}>
											<span className={css.infoLabel}>HDR</span>
											<span className={css.infoValue}>{getHdrType()}</span>
										</div>
										<div className={css.infoRow}>
											<span className={css.infoLabel}>Codec</span>
											<span className={css.infoValue}>{getVideoCodec()}</span>
										</div>
										{videoStream.BitRate && (
											<div className={css.infoRow}>
												<span className={css.infoLabel}>Video Bitrate</span>
												<span className={css.infoValue}>{formatBitrate(videoStream.BitRate)}</span>
											</div>
										)}
									</SpottableDiv>
								)}

								{/* Audio Section */}
								{audioStream && (
									<SpottableDiv className={css.infoSection} spotlightId="info-audio">
										<h3 className={css.infoHeader}>Audio</h3>
										<div className={css.infoRow}>
											<span className={css.infoLabel}>Track</span>
											<span className={css.infoValue}>
												{audioStream.DisplayTitle || audioStream.Language || 'Unknown'}
											</span>
										</div>
										<div className={css.infoRow}>
											<span className={css.infoLabel}>Codec</span>
											<span className={css.infoValue}>{getAudioCodec()}</span>
										</div>
										<div className={css.infoRow}>
											<span className={css.infoLabel}>Channels</span>
											<span className={css.infoValue}>{getAudioChannels()}</span>
										</div>
										{audioStream.BitRate && (
											<div className={css.infoRow}>
												<span className={css.infoLabel}>Audio Bitrate</span>
												<span className={css.infoValue}>{formatBitrate(audioStream.BitRate)}</span>
											</div>
										)}
										{audioStream.SampleRate && (
											<div className={css.infoRow}>
												<span className={css.infoLabel}>Sample Rate</span>
												<span className={css.infoValue}>{(audioStream.SampleRate / 1000).toFixed(1)} kHz</span>
											</div>
										)}
									</SpottableDiv>
								)}

								{/* Subtitle Section */}
								{subtitleStream && (
									<SpottableDiv className={css.infoSection} spotlightId="info-subtitles">
										<h3 className={css.infoHeader}>Subtitles</h3>
										<div className={css.infoRow}>
											<span className={css.infoLabel}>Track</span>
											<span className={css.infoValue}>
												{subtitleStream.DisplayTitle || subtitleStream.Language || 'Unknown'}
											</span>
										</div>
										<div className={css.infoRow}>
											<span className={css.infoLabel}>Format</span>
											<span className={css.infoValue}>
												{(subtitleStream.Codec || 'Unknown').toUpperCase()}
											</span>
										</div>
										<div className={css.infoRow}>
											<span className={css.infoLabel}>Type</span>
											<span className={css.infoValue}>
												{subtitleStream.IsExternal ? 'External' : 'Embedded'}
											</span>
										</div>
									</SpottableDiv>
								)}
							</Scroller>
							<p className={css.modalFooter}>Press BACK to close</p>
						</div>
					</div>
				);
			})()}

			{/* Subtitle Offset Modal */}
			<SubtitleOffsetOverlay
				visible={activeModal === 'subtitleOffset'}
				currentOffset={subtitleOffset}
				onClose={closeModal}
				onOffsetChange={handleSubtitleOffsetChange}
			/>

			{/* Subtitle Settings Modal */}
			<SubtitleSettingsOverlay
				visible={activeModal === 'subtitleSettings'}
				onClose={closeModal}
			/>
		</div>
	);
};

export default Player;
