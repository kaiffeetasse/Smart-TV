import {useState, useEffect, useCallback, useRef, useMemo} from 'react';
import Spotlight from '@enact/spotlight';
import Button from '@enact/sandstone/Button';
import * as playback from '../../services/playback';
import {getImageUrl} from '../../utils/helpers';
import {getServerUrl} from '../../services/jellyfinApi';
import {
	initLunaAPI,
	registerAppStateObserver,
	keepScreenOn,
	cleanupVideoElement,
	setupVisibilityHandler,
	setupWebOSLifecycle
} from '@moonfin/platform-webos/video';
import {useSettings} from '../../context/SettingsContext';
import PlayerControls, {usePlayerButtons} from './PlayerControls';
import useSegmentPopups from './useSegmentPopups';
import {
	SpottableButton, NextEpisodeContainer, CONTROLS_HIDE_DELAY
} from './PlayerConstants';

import css from './WebOSPlayer.module.less';

const Player = ({item, resume, initialAudioIndex, initialSubtitleIndex, onEnded, onBack, onPlayNext, audioPlaylist}) => {
	const {settings} = useSettings();

	const [mediaUrl, setMediaUrl] = useState(null);
	const [mimeType, setMimeType] = useState('video/mp4');
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
	const [subtitleTrackEvents, setSubtitleTrackEvents] = useState(null)
	const [currentSubtitleText, setCurrentSubtitleText] = useState(null);
	const [subtitleOffset, setSubtitleOffset] = useState(0);
	const [controlsVisible, setControlsVisible] = useState(false);
	const [activeModal, setActiveModal] = useState(null);
	const [playbackRate, setPlaybackRate] = useState(1);
	const [selectedQuality, setSelectedQuality] = useState(null);
	const [mediaSegments, setMediaSegments] = useState(null);
	const [nextEpisode, setNextEpisode] = useState(null);
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



	const videoRef = useRef(null);
	const positionRef = useRef(0);
	const playSessionRef = useRef(null);
	const runTimeRef = useRef(0);
	const healthMonitorRef = useRef(null);
	const unregisterAppStateRef = useRef(null);
	const controlsTimeoutRef = useRef(null);
	const lastSeekTargetRef = useRef(null);
	const seekingTranscodeRef = useRef(false);
	const seekDebounceTimerRef = useRef(null);
	const isCleaningUpRef = useRef(false);
	const transcodeOffsetTicksRef = useRef(0);
	const transcodeOffsetDetectedRef = useRef(true);
	const playbackStartTimeoutRef = useRef(null);

	const {topButtons, bottomButtons} = usePlayerButtons({
		isPaused, audioStreams, subtitleStreams, chapters,
		nextEpisode, isAudioMode, hasNextTrack, hasPrevTrack
	});

	useEffect(() => {
		const init = async () => {
			await initLunaAPI();
			await keepScreenOn(true);

			unregisterAppStateRef.current = registerAppStateObserver(
				() => {
					console.log('[Player] App resumed');
					if (videoRef.current && !isPaused) {
						videoRef.current.play();
					}
				},
				() => {
					console.log('[Player] App backgrounded');
				}
			);
		};
		init();

		return () => {
			keepScreenOn(false);
			if (unregisterAppStateRef.current) {
				unregisterAppStateRef.current();
			}
		};
	}, [isPaused]);

	// Handle webOS app visibility and relaunch events to properly pause/cleanup video
	useEffect(() => {
		let wasPlaying = false;

		const handleAppHidden = () => {
			console.log('[Player] App hidden - pausing and saving progress');
			if (videoRef.current) {
				wasPlaying = !videoRef.current.paused;
				if (wasPlaying) {
					videoRef.current.pause();
				}
			}
			// Report current progress when app is backgrounded
			// This ensures position is saved if user doesn't return
			if (positionRef.current > 0) {
				playback.reportProgress(positionRef.current);
			}
		};

		const handleAppVisible = () => {
			console.log('[Player] App visible - resuming if was playing');
			if (videoRef.current && wasPlaying) {
				videoRef.current.play().catch(err => {
					console.warn('[Player] Failed to resume playback:', err);
				});
			}
		};

		const handleRelaunch = (params) => {
			console.log('[Player] App relaunched with params:', params);
			if (videoRef.current) {
				cleanupVideoElement(videoRef.current);
			}
		};

		const removeVisibilityHandler = setupVisibilityHandler(handleAppHidden, handleAppVisible);
		const removeWebOSHandler = setupWebOSLifecycle(handleRelaunch);

		return () => {
			removeVisibilityHandler();
			removeWebOSHandler();
		};
	}, []);

	useEffect(() => {
		const videoElement = videoRef.current;
		console.log('[Player] Main useEffect running with deps:', {
			itemId: item?.Id,
			selectedQuality,
			maxBitrate: settings.maxBitrate,
			preferTranscode: settings.preferTranscode,
			subtitleMode: settings.subtitleMode,
			skipIntro: settings.skipIntro,
			initialAudioIndex,
			initialSubtitleIndex
		});

		const loadMedia = async () => {
			setIsLoading(true);
			setError(null);

			resetPopups();
			setNextEpisode(null);

			try {
				const savedPosition = item.UserData?.PlaybackPositionTicks || 0;
				const startPosition = resume !== false ? savedPosition : 0;
				console.log('[Player] Start position:', {
					resume,
					savedPosition,
					startPosition,
					hasUserData: !!item.UserData
				});
				const result = await playback.getPlaybackInfo(item.Id, {
					startPositionTicks: startPosition,
					maxBitrate: selectedQuality || settings.maxBitrate,
					enableDirectPlay: !settings.preferTranscode,
					enableDirectStream: !settings.preferTranscode,
					forceDirectPlay: settings.forceDirectPlay,
					// Cross-server support: pass item for server credential lookup
					item: item
				});

				setMediaUrl(result.url);
				setMimeType(result.mimeType || 'video/mp4');
				setPlayMethod(result.playMethod);
				setMediaSourceId(result.mediaSourceId);
				playSessionRef.current = result.playSessionId;

				positionRef.current = startPosition;
				lastSeekTargetRef.current = null;
				seekingTranscodeRef.current = false;

				if (result.playMethod === 'Transcode' && startPosition > 0) {
					transcodeOffsetTicksRef.current = startPosition;
					transcodeOffsetDetectedRef.current = false;
				} else {
					transcodeOffsetTicksRef.current = 0;
					transcodeOffsetDetectedRef.current = true;
				}

				runTimeRef.current = result.runTimeTicks || 0;
				setDuration((result.runTimeTicks || 0) / 10000000);

				setAudioStreams(result.audioStreams || []);
				setSubtitleStreams(result.subtitleStreams || []);
				setChapters(result.chapters || []);

				const defaultAudio = result.audioStreams?.find(s => s.isDefault);
				if (initialAudioIndex !== undefined && initialAudioIndex !== null) {
					setSelectedAudioIndex(initialAudioIndex);
				} else if (defaultAudio) {
					setSelectedAudioIndex(defaultAudio.index);
				}

				console.log('[Player] === SUBTITLE SELECTION START ===');
				console.log('[Player] initialSubtitleIndex:', initialSubtitleIndex);
				console.log('[Player] subtitleMode:', settings.subtitleMode);
				console.log('[Player] availableSubtitles:', result.subtitleStreams?.length || 0);
				if (result.subtitleStreams) {
					result.subtitleStreams.forEach((s, i) => {
						console.log('[Player] Subtitle ' + i + ': index=' + s.index + ' codec=' + s.codec + ' lang=' + s.language + ' default=' + s.isDefault + ' forced=' + s.isForced + ' text=' + s.isTextBased);
					});
				}

				// Helper to load subtitle data
				const loadSubtitleData = async (sub) => {
					console.log('[Player] loadSubtitleData called for:', sub?.index, 'isTextBased:', sub?.isTextBased);
					if (sub && sub.isTextBased) {
						try {
							console.log('[Player] Fetching subtitle JSON data...');
							const data = await playback.fetchSubtitleData(sub);
							console.log('[Player] fetchSubtitleData returned:', data ? 'data' : 'null', 'events:', data?.TrackEvents?.length);
							if (data && data.TrackEvents) {
								setSubtitleTrackEvents(data.TrackEvents);
								console.log('[Player] Set subtitleTrackEvents with', data.TrackEvents.length, 'events');
							} else {
								console.log('[Player] No TrackEvents in response');
								setSubtitleTrackEvents(null);
							}
						} catch (err) {
							console.error('[Player] Error fetching subtitle data:', err);
							setSubtitleTrackEvents(null);
						}
					} else {
						console.log('[Player] Not loading subs - sub:', !!sub, 'isTextBased:', sub?.isTextBased);
						setSubtitleTrackEvents(null);
					}
					setCurrentSubtitleText(null);
				};

				if (initialSubtitleIndex !== undefined && initialSubtitleIndex !== null) {
					console.log('[Player] Using initialSubtitleIndex path');
					if (initialSubtitleIndex >= 0) {
						const selectedSub = result.subtitleStreams?.find(s => s.index === initialSubtitleIndex);
						if (selectedSub) {
							console.log('[Player] Using initial subtitle index:', initialSubtitleIndex);
							setSelectedSubtitleIndex(initialSubtitleIndex);
							await loadSubtitleData(selectedSub);
						}
					} else {
						// -1 means subtitles off
						console.log('[Player] initialSubtitleIndex is -1, subtitles off');
						setSelectedSubtitleIndex(-1);
						setSubtitleTrackEvents(null);
					}
				} else if (settings.subtitleMode === 'always') {
					console.log('[Player] Using subtitleMode=always path');
					const defaultSub = result.subtitleStreams?.find(s => s.isDefault);
					if (defaultSub) {
						console.log('[Player] Using default subtitle (always mode):', defaultSub.index);
						setSelectedSubtitleIndex(defaultSub.index);
						await loadSubtitleData(defaultSub);
					} else if (result.subtitleStreams?.length > 0) {
						// No default marked, use first available
						const firstSub = result.subtitleStreams[0];
						console.log('[Player] No default subtitle, using first:', firstSub.index);
						setSelectedSubtitleIndex(firstSub.index);
						await loadSubtitleData(firstSub);
					} else {
						console.log('[Player] subtitleMode=always but no subtitles available');
					}
				} else if (settings.subtitleMode === 'forced') {
					console.log('[Player] Using subtitleMode=forced path');
					const forcedSub = result.subtitleStreams?.find(s => s.isForced);
					if (forcedSub) {
						console.log('[Player] Using forced subtitle:', forcedSub.index);
						setSelectedSubtitleIndex(forcedSub.index);
						await loadSubtitleData(forcedSub);
					} else {
						console.log('[Player] No forced subtitle found');
					}
				} else {
					console.log('[Player] No subtitle auto-selected - subtitleMode is:', settings.subtitleMode);
				}
				console.log('[Player] === SUBTITLE SELECTION END ===');

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

					if (item.Type === 'Episode') {
						const next = await playback.getNextEpisode(item);
						setNextEpisode(next);
					}
				}

				console.log(`[Player] Loaded ${displayTitle} via ${result.playMethod}`);
			} catch (err) {
				console.error('[Player] Failed to load media:', err);
				setError(err.message || 'Failed to load media');
			} finally {
				setIsLoading(false);
			}
		};

		loadMedia();

		return () => {
			console.log('[Player] Cleanup running - unmounting or re-rendering');

			const videoTime = videoElement ? videoElement.currentTime : 0;
			const videoTicks = Math.floor(videoTime * 10000000) + transcodeOffsetTicksRef.current;
			const currentPos = videoTicks > 0 ? videoTicks : positionRef.current;

			const intendedStart = positionRef.current;
			const playedMeaningfully = videoTicks > 100000000;
			if (currentPos > 0 && (playedMeaningfully || intendedStart === 0)) {
				console.log('[Player] Reporting stop at position:', currentPos, 'ticks');
				playback.reportStop(currentPos);
			} else {
				console.log('[Player] Skipping reportStop - position too small:', currentPos,
					'videoTime:', videoTime, 'intendedStart:', intendedStart);
			}

			playback.stopProgressReporting();
			playback.stopHealthMonitoring();

			resetPopups();
			if (controlsTimeoutRef.current) {
				clearTimeout(controlsTimeoutRef.current);
			}
			if (seekDebounceTimerRef.current) {
				clearTimeout(seekDebounceTimerRef.current);
			}

			// Quick sync release — handleBack/handleEnded already did the
			// full async cleanup with SDR reset.  This is only a safety net
			// for unmount paths that bypass those handlers (settings change, etc.).
			isCleaningUpRef.current = true;
			if (videoElement) {
				try { videoElement.pause(); } catch (e) { /* ignore */ }
				videoElement.removeAttribute('src');
				videoElement.load();
			}
		};
	}, [item, resume, selectedQuality, settings.maxBitrate, settings.preferTranscode, settings.forceDirectPlay, settings.subtitleMode, settings.skipIntro, initialAudioIndex, initialSubtitleIndex]);

	useEffect(() => {
		if (mediaUrl) {
			console.log('[Player] mediaUrl set:', mediaUrl);
		}
	}, [mediaUrl]);

	const seekInTranscode = useCallback(async (seekPositionTicks) => {
		if (seekingTranscodeRef.current) return;
		seekingTranscodeRef.current = true;

		if (seekDebounceTimerRef.current) {
			clearTimeout(seekDebounceTimerRef.current);
			seekDebounceTimerRef.current = null;
		}

		console.log('[Player] seekInTranscode: requesting new stream at', seekPositionTicks, 'ticks (', seekPositionTicks / 10000000, 's)');

		try {
			const result = await playback.getPlaybackInfo(item.Id, {
				startPositionTicks: seekPositionTicks,
				maxBitrate: selectedQuality || settings.maxBitrate,
				enableDirectPlay: false,
				enableDirectStream: false,
				enableTranscoding: true,
				item: item
			});

			if (result.url) {
				positionRef.current = seekPositionTicks;
				lastSeekTargetRef.current = seekPositionTicks;
				transcodeOffsetTicksRef.current = seekPositionTicks;
				transcodeOffsetDetectedRef.current = false;

				setMediaUrl(result.url);
				setPlayMethod(result.playMethod);
				setMimeType(result.mimeType || 'video/mp4');
				playSessionRef.current = result.playSessionId;

				console.log('[Player] seekInTranscode: new stream loaded at', seekPositionTicks / 10000000, 'seconds');
			}
		} catch (err) {
			console.error('[Player] seekInTranscode failed:', err);
			setError('Failed to seek - please try again');
		} finally {
			seekingTranscodeRef.current = false;
		}
	}, [item, selectedQuality, settings.maxBitrate]);

	// Seek relative to current position with debounced transcode re-requests.
	// updateSeekPosition: also update the seekbar UI during scrubbing.
	const seekByOffset = useCallback((deltaSec, updateSeekPosition) => {
		const baseTime = (playMethod === 'Transcode')
			? ((lastSeekTargetRef.current != null ? lastSeekTargetRef.current : positionRef.current) / 10000000)
			: (videoRef.current ? videoRef.current.currentTime : 0);
		const newTime = Math.max(0, Math.min(duration, baseTime + deltaSec));
		const newTicks = Math.floor(newTime * 10000000);
		if (updateSeekPosition) setSeekPosition(newTicks);
		positionRef.current = newTicks;
		lastSeekTargetRef.current = newTicks;
		if (playMethod === 'Transcode') {
			setCurrentTime(newTime);
			if (seekDebounceTimerRef.current) clearTimeout(seekDebounceTimerRef.current);
			seekingTranscodeRef.current = false;
			seekDebounceTimerRef.current = setTimeout(() => {
				seekInTranscode(lastSeekTargetRef.current);
			}, 600);
		} else if (videoRef.current) {
			videoRef.current.currentTime = newTime;
		}
	}, [duration, playMethod, seekInTranscode]);

	const seekToTicks = useCallback((ticks) => {
		if (!videoRef.current) return;
		positionRef.current = ticks;
		lastSeekTargetRef.current = ticks;
		if (playMethod === 'Transcode') {
			seekInTranscode(ticks);
		} else {
			videoRef.current.currentTime = ticks / 10000000;
		}
	}, [playMethod, seekInTranscode]);

	useEffect(() => {
		const video = videoRef.current;
		console.log('[Player] Video src useEffect - video exists:', !!video, 'mediaUrl:', !!mediaUrl, 'isLoading:', isLoading);

		if (!video || !mediaUrl || isLoading) return;

		console.log('[Player] Setting video src via ref:', mediaUrl);
		console.log('[Player] PlayMethod:', playMethod, 'MimeType:', mimeType);

		// Set webOS-specific attributes that React doesn't handle well
		video.setAttribute('webkit-playsinline', '');
		video.setAttribute('playsinline', '');
		video.setAttribute('preload', 'auto');

		const isHls = mediaUrl.includes('.m3u8') || mimeType === 'application/x-mpegURL';

		const setSourceAndPlay = () => {
			console.log('[Player] Setting video source now');
			video.src = mediaUrl;
			video.load();

			// Start a playback timeout — if no timeupdate fires within 8 seconds,
			// synthetically trigger the error handler to fall back to transcoding.
			// Some formats silently fail in the HTML5 <video> element without firing
			// an error event, resulting in a black screen.
			if (playbackStartTimeoutRef.current) {
				clearTimeout(playbackStartTimeoutRef.current);
			}
			const onFirstTimeUpdate = () => {
				clearTimeout(playbackStartTimeoutRef.current);
				playbackStartTimeoutRef.current = null;
				video.removeEventListener('timeupdate', onFirstTimeUpdate);
			};
			video.addEventListener('timeupdate', onFirstTimeUpdate);
			playbackStartTimeoutRef.current = setTimeout(() => {
				video.removeEventListener('timeupdate', onFirstTimeUpdate);
				// Check if playback actually started
				if (video.currentTime === 0 && (video.readyState < 3 || video.paused)) {
					console.warn('[Player] Playback start timeout — no timeupdate received in 8s, triggering error handler');
					console.warn('[Player] Video state:', { readyState: video.readyState, networkState: video.networkState, paused: video.paused, currentSrc: video.currentSrc });
					video.dispatchEvent(new Event('error'));
				}
			}, 8000);

			video.play().then(() => {
				console.log('[Player] play() promise resolved');
			}).catch(err => {
				// "interrupted by a new load request" is normal during source
				// transitions (e.g. DirectPlay → Transcode fallback).
				if (err.name === 'AbortError') {
					console.log('[Player] play() aborted (source transition) — expected');
				} else {
					console.error('[Player] play() promise rejected:', err);
				}
			});
		};

		setSourceAndPlay();

		return () => {
			if (playbackStartTimeoutRef.current) {
				clearTimeout(playbackStartTimeoutRef.current);
				playbackStartTimeoutRef.current = null;
			}
		};
	}, [mediaUrl, isLoading, mimeType, playMethod]);

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

	// Handle playback health issues — if the health monitor detects stalled
	// playback (no progress for extended period), fall back to transcoding.
	const handleUnhealthy = useCallback(async () => {
		console.log('[Player] Playback unhealthy, falling back to transcode');
		if (!hasTriedTranscode && playMethod !== 'Transcode') {
			const video = videoRef.current;
			if (video) {
				console.warn('[Player] Health monitor triggering transcode fallback');
				video.dispatchEvent(new Event('error'));
			}
		}
	}, [hasTriedTranscode, playMethod]);

	const onPlayNextWithCleanup = useCallback(async (episode) => {
		await playback.reportStop(positionRef.current);
		onPlayNext(episode);
	}, [onPlayNext]);

	const onSeekToIntroEnd = useCallback(() => {
		if (mediaSegments?.introEnd && videoRef.current) {
			seekToTicks(mediaSegments.introEnd);
		}
	}, [mediaSegments, seekToTicks]);

	const {
		showSkipIntro, showSkipCredits, showNextEpisode, nextEpisodeCountdown,
		handleSkipIntro, handlePlayNextEpisode, cancelNextEpisodeCountdown,
		checkSegments, handlePopupKeyDown, resetPopups
	} = useSegmentPopups({
		mediaSegments, nextEpisode, settings, runTimeRef,
		activeModal, controlsVisible, hideControls, showControls,
		onSeekToIntroEnd,
		onPlayNext: onPlayNextWithCleanup
	});

	// Audio playlist: next track
	const handleNextTrack = useCallback(async () => {
		if (hasNextTrack && onPlayNext) {
			await playback.reportStop(positionRef.current);
			onPlayNext(audioPlaylist[audioPlaylistIndex + 1]);
		}
	}, [hasNextTrack, onPlayNext, audioPlaylist, audioPlaylistIndex]);

	// Audio playlist: previous track (or restart current if >3s in)
	const handlePrevTrack = useCallback(async () => {
		const video = videoRef.current;
		if (video && video.currentTime > 3) {
			// Restart current track
			video.currentTime = 0;
			return;
		}
		if (hasPrevTrack && onPlayNext) {
			await playback.reportStop(positionRef.current);
			onPlayNext(audioPlaylist[audioPlaylistIndex - 1]);
		}
	}, [hasPrevTrack, onPlayNext, audioPlaylist, audioPlaylistIndex]);

	const handleLoadedMetadata = useCallback(() => {
		if (videoRef.current) {
			if (playMethod !== 'Transcode') {
				setDuration(videoRef.current.duration);
			}
			videoRef.current.play().catch(err => {
				console.error('[Player] Failed to start playback:', err);
			});
		}
	}, [playMethod]);

	const handlePlay = useCallback(() => {
		setIsPaused(false);
		playback.reportStart(positionRef.current);
		playback.startProgressReporting(() => positionRef.current);
		playback.startHealthMonitoring(handleUnhealthy);
		healthMonitorRef.current = playback.getHealthMonitor();
	}, [handleUnhealthy]);

	const handlePause = useCallback(() => {
		setIsPaused(true);
	}, []);

	const handleTimeUpdate = useCallback(() => {
		if (videoRef.current) {
			const rawTime = videoRef.current.currentTime;

			if (playMethod === 'Transcode' && !transcodeOffsetDetectedRef.current && transcodeOffsetTicksRef.current > 0) {
				if (rawTime > 1) {
					transcodeOffsetDetectedRef.current = true;
					const expectedSec = transcodeOffsetTicksRef.current / 10000000;
					if (rawTime > expectedSec * 0.5) {
						transcodeOffsetTicksRef.current = 0;
						console.log('[Player] Transcode timestamps: absolute (no offset needed)');
					} else {
						console.log('[Player] Transcode timestamps: relative, applying offset:', expectedSec, 's');
					}
				} else {
					positionRef.current = transcodeOffsetTicksRef.current;
					setCurrentTime(transcodeOffsetTicksRef.current / 10000000);
					return;
				}
			}

			const time = rawTime + transcodeOffsetTicksRef.current / 10000000;
			setCurrentTime(time);
			const ticks = Math.floor(time * 10000000);
			positionRef.current = ticks;

			if (healthMonitorRef.current) {
				healthMonitorRef.current.recordProgress();
			}

			if (subtitleTrackEvents && subtitleTrackEvents.length > 0) {
				// Apply offset: lookupTime = currentTime - offset
				// If offset is positive (delay), we look at earlier time in the subtitle track
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

			checkSegments(ticks);
		}
	}, [playMethod, checkSegments, subtitleTrackEvents, subtitleOffset]);

	const handleWaiting = useCallback(() => {
		setIsBuffering(true);
		if (healthMonitorRef.current) {
			healthMonitorRef.current.recordBuffer();
		}
	}, []);

	const handlePlaying = useCallback(() => {
		setIsBuffering(false);
		if (!seekDebounceTimerRef.current) {
			lastSeekTargetRef.current = null;
		}
	}, []);

	const handleEnded = useCallback(async () => {
		await playback.reportStop(positionRef.current);

		// Cleanup video element before navigating to next episode or exiting.
		// Await ensures HW decoder is fully released before new media loads.
		isCleaningUpRef.current = true;
		await cleanupVideoElement(videoRef.current);
		isCleaningUpRef.current = false;

		// Auto-advance to next track in audio playlist
		if (hasNextTrack && onPlayNext) {
			onPlayNext(audioPlaylist[audioPlaylistIndex + 1]);
		} else if (nextEpisode && onPlayNext) {
			onPlayNext(nextEpisode);
		} else {
			onEnded?.();
		}
	}, [onEnded, onPlayNext, nextEpisode, hasNextTrack, audioPlaylist, audioPlaylistIndex]);

	const handleError = useCallback(async () => {
		// Ignore errors fired during cleanup (SDR reset video triggers error code 4)
		if (isCleaningUpRef.current) {
			console.log('[Player] Ignoring error during cleanup');
			return;
		}

		const video = videoRef.current;
		let errorMessage = 'Playback failed.';

		if (video?.error) {
			switch (video.error.code) {
				case 1:
					errorMessage = 'Playback was aborted.';
					break;
				case 2:
					errorMessage = 'A network error occurred. Check your connection.';
					break;
				case 3:
					errorMessage = 'The video format is not supported by this TV.';
					break;
				case 4:
					errorMessage = 'The video source is not supported.';
					break;
				default:
					errorMessage = 'An unknown playback error occurred.';
			}
			console.error('[Player] Playback error:', video.error.code, video.error.message);
			console.error('[Player] Error details:', {
				code: video.error.code,
				message: video.error.message,
				currentSrc: video.currentSrc,
				readyState: video.readyState,
				networkState: video.networkState,
				playMethod: playMethod
			});
		} else {
			console.error('[Player] Playback error (no error object)');
		}

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
					// Cross-server support: pass item for server credential lookup
					item: item
				});

				if (result.url) {
					// Give the server a moment to prepare the transcode stream
					console.log('[Player] Waiting for transcode to initialize...');
					await new Promise(resolve => setTimeout(resolve, 1500));

					setMediaUrl(result.url);
					setPlayMethod(result.playMethod);
					setMimeType(result.mimeType || 'video/mp4');
					playSessionRef.current = result.playSessionId;
					return;
				}
			} catch (fallbackErr) {
				console.error('[Player] Transcode fallback failed:', fallbackErr);
				errorMessage = 'Transcoding failed. The server may not support this format.';
			}
		}

		setError(errorMessage);
	}, [hasTriedTranscode, playMethod, item, selectedQuality, settings.maxBitrate]);

	const handleImageError = useCallback((e) => {
		e.target.style.display = 'none';
	}, []);

	const handleBack = useCallback(async () => {
		cancelNextEpisodeCountdown();
		const currentPos = videoRef.current
			? Math.floor(videoRef.current.currentTime * 10000000) + transcodeOffsetTicksRef.current
			: positionRef.current;
		await playback.reportStop(currentPos);

		isCleaningUpRef.current = true;
		await cleanupVideoElement(videoRef.current);
		isCleaningUpRef.current = false;

		onBack?.();
	}, [onBack, cancelNextEpisodeCountdown]);

	const handlePlayPause = useCallback(() => {
		if (videoRef.current) {
			if (isPaused) {
				videoRef.current.play();
			} else {
				videoRef.current.pause();
			}
		}
	}, [isPaused]);

	const handleRewind = useCallback(() => {
		if (videoRef.current) seekByOffset(-settings.seekStep);
	}, [settings.seekStep, seekByOffset]);

	const handleForward = useCallback(() => {
		if (videoRef.current) seekByOffset(settings.seekStep);
	}, [settings.seekStep, seekByOffset]);

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

	const handleSubtitleKeyDown = useCallback((e) => {
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

	const handleOpenSubtitleOffset = useCallback(() => {
		openModal('subtitleOffset');
	}, [openModal]);

	const handleOpenSubtitleSettings = useCallback(() => {
		openModal('subtitleSettings');
	}, [openModal]);

	// Track selection - using data attributes to avoid arrow functions in JSX
	const handleSelectAudio = useCallback(async (e) => {
		const index = parseInt(e.currentTarget.dataset.index, 10);
		if (isNaN(index)) return;
		setSelectedAudioIndex(index);
		closeModal();

		// Reset fallback flag so the DirectPlay→Transcode fallback can trigger again
		// if the new audio track also fails at the decoder level.
		setHasTriedTranscode(false);

		try {
			// DirectPlay: try native audioTracks API for instant switch without reload
			if (playMethod !== playback.PlayMethod.Transcode && videoRef.current?.audioTracks?.length > 1) {
				const audioTrackList = videoRef.current.audioTracks;
				const audioStreamIndices = audioStreams.map(s => s.index);
				const trackPosition = audioStreamIndices.indexOf(index);

				if (trackPosition >= 0 && trackPosition < audioTrackList.length) {
					for (let i = 0; i < audioTrackList.length; i++) {
						audioTrackList[i].enabled = (i === trackPosition);
					}
					console.log('[Player] Switched audio natively via audioTracks API');
					return;
				}
			}

			// Fallback: re-request playback info with current position preserved
			const currentPositionTicks = videoRef.current
				? Math.floor(videoRef.current.currentTime * 10000000)
				: positionRef.current || 0;

			const result = await playback.changeAudioStream(index, currentPositionTicks);
			if (result) {
				positionRef.current = currentPositionTicks;
				let newUrl = result.url;
				// Cache-buster for DirectPlay so the video element reloads
				if (result.playMethod === playback.PlayMethod.DirectPlay) {
					const separator = newUrl.includes('?') ? '&' : '?';
					newUrl = `${newUrl}${separator}_audioSwitch=${Date.now()}`;
				}
				setMediaUrl(newUrl);
				if (result.playMethod) setPlayMethod(result.playMethod);
				setMimeType(result.mimeType || 'video/mp4');
			}
		} catch (err) {
			console.error('[Player] Failed to change audio:', err);
		}
	}, [playMethod, closeModal, audioStreams]);

	const handleSelectSubtitle = useCallback(async (e) => {
		const index = parseInt(e.currentTarget.dataset.index, 10);
		console.log('[Player] handleSelectSubtitle called with index:', index);
		if (isNaN(index)) return;
		if (index === -1) {
			console.log('[Player] Turning subtitles OFF');
			setSelectedSubtitleIndex(-1);
			setSubtitleTrackEvents(null);
			setCurrentSubtitleText(null);
		} else {
			console.log('[Player] Selecting subtitle index:', index);
			setSelectedSubtitleIndex(index);
			const stream = subtitleStreams.find(s => s.index === index);
			console.log('[Player] Found stream:', stream ? 'yes' : 'no', 'codec:', stream?.codec, 'isTextBased:', stream?.isTextBased);
			// Fetch subtitle data as JSON for custom rendering (webOS doesn't support native <track>)
			if (stream && stream.isTextBased) {
				try {
					console.log('[Player] Fetching subtitle data for text-based sub...');
					const data = await playback.fetchSubtitleData(stream);
					console.log('[Player] Got subtitle data:', data ? 'yes' : 'no', 'TrackEvents:', data?.TrackEvents?.length);
					if (data && data.TrackEvents) {
						setSubtitleTrackEvents(data.TrackEvents);
						console.log('[Player] Manual select: Loaded', data.TrackEvents.length, 'subtitle events');
					} else {
						console.log('[Player] No TrackEvents in response');
						setSubtitleTrackEvents(null);
					}
				} catch (err) {
					console.error('[Player] Error fetching subtitle data:', err);
					setSubtitleTrackEvents(null);
				}
			} else {
				// PGS/image-based subtitles - cannot render client-side, need to burn in via transcode
				console.log('[Player] Image-based subtitle (codec:', stream?.codec, ') - requires burn-in via transcode');
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
		if (videoRef.current) {
			videoRef.current.playbackRate = rate;
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
		if (isNaN(ticks) || ticks < 0) return;
		seekToTicks(ticks);
		closeModal();
	}, [closeModal, seekToTicks]);

	const handleProgressClick = useCallback((e) => {
		if (!videoRef.current) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const percent = (e.clientX - rect.left) / rect.width;
		const newTime = percent * duration;
		const newTicks = Math.floor(newTime * 10000000);
		seekToTicks(newTicks);
	}, [duration, seekToTicks]);

	const handleProgressKeyDown = useCallback((e) => {
		if (!videoRef.current) return;
		const step = settings.seekStep;
		showControls();

		if (e.key === 'ArrowLeft' || e.keyCode === 37) {
			e.preventDefault();
			setIsSeeking(true);
			seekByOffset(-step, true);
		} else if (e.key === 'ArrowRight' || e.keyCode === 39) {
			e.preventDefault();
			setIsSeeking(true);
			seekByOffset(step, true);
		} else if (e.key === 'ArrowUp' || e.keyCode === 38) {
			e.preventDefault();
			setFocusRow('top');
			setIsSeeking(false);
			window.requestAnimationFrame(() => Spotlight.focus('play-pause-btn'));
		} else if (e.key === 'ArrowDown' || e.keyCode === 40) {
			e.preventDefault();
			setFocusRow('bottom');
			setIsSeeking(false);
		}
	}, [settings.seekStep, seekByOffset, showControls]);

	const handleProgressBlur = useCallback(() => {
		setIsSeeking(false);
	}, []);

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

	const handleControlButtonClick = useCallback((e) => {
		const action = e.currentTarget.dataset.action;
		if (action) {
			handleButtonAction(action);
		}
	}, [handleButtonAction]);

	const handleSubtitleOffsetChange = useCallback((newOffset) => {
		setSubtitleOffset(newOffset);
	}, []);

	const stopPropagation = useCallback((e) => {
		e.stopPropagation();
	}, []);

	useEffect(() => {
		const handleKeyDown = (e) => {
			const key = e.key || e.keyCode;

			if (handlePopupKeyDown(e)) return;

			// Media playback keys (webOS remote)
			// Play: 415, Pause: 19, Fast-forward: 417, Rewind: 412, Stop: 413
			if (e.keyCode === 415) {
				e.preventDefault();
				e.stopPropagation();
				if (videoRef.current && videoRef.current.paused) {
					videoRef.current.play();
				}
				return;
			}
			if (e.keyCode === 19) {
				e.preventDefault();
				e.stopPropagation();
				if (videoRef.current && !videoRef.current.paused) {
					videoRef.current.pause();
				}
				return;
			}
			if (e.keyCode === 417) {
				e.preventDefault();
				e.stopPropagation();
				handleForward();
				showControls();
				return;
			}
			if (e.keyCode === 412) {
				e.preventDefault();
				e.stopPropagation();
				handleRewind();
				showControls();
				return;
			}
			if (e.keyCode === 413) {
				e.preventDefault();
				e.stopPropagation();
				handleBack();
				return;
			}

			if (key === 'GoBack' || key === 'Backspace' || e.keyCode === 461 || e.keyCode === 8 || e.keyCode === 27) {
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
					setSeekPosition(Math.floor(currentTime * 10000000));
					// Apply the seek step immediately
					const step = settings.seekStep;
					if (key === 'ArrowLeft' || e.keyCode === 37) {
						seekByOffset(-step, true);
					} else {
						seekByOffset(step, true);
					}
					return;
				}
				e.preventDefault();
				showControls();
				return;
			}

			// Up/Down arrow navigation between rows when controls are visible
			if (controlsVisible && !activeModal) {
				if (key === 'ArrowUp' || e.keyCode === 38) {
					e.preventDefault();
					showControls();
					setFocusRow(prev => {
						if (prev === 'bottom') return 'progress';
						if (prev === 'progress') {
							window.requestAnimationFrame(() => Spotlight.focus('play-pause-btn'));
							return 'top';
						}
						return 'top';
					});
					return;
				}
				if (key === 'ArrowDown' || e.keyCode === 40) {
					e.preventDefault();
					showControls();
					setFocusRow(prev => {
						if (prev === 'top') return 'progress';
						if (prev === 'progress') return bottomButtons.length > 0 ? 'bottom' : 'progress';
						return 'bottom'; // Already at bottom, stay there
					});
					return;
				}
			}

			// Play/Pause with Enter when controls not focused
			if ((key === 'Enter' || e.keyCode === 13) && !controlsVisible) {
				handlePlayPause();
				return;
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [controlsVisible, activeModal, closeModal, hideControls, handleBack, showControls, handlePlayPause, handleForward, handleRewind, currentTime, settings.seekStep, seekByOffset, handlePopupKeyDown, bottomButtons.length]);

	const displayTime = isSeeking ? (seekPosition / 10000000) : currentTime;
	const progressPercent = duration > 0 ? (displayTime / duration) * 100 : 0;

	useEffect(() => {
		if (!controlsVisible) return;

		window.requestAnimationFrame(() => {
			if (focusRow === 'progress') {
				Spotlight.focus('progress-bar');
			} else if (focusRow === 'bottom') {
				Spotlight.focus('bottom-row-default');
			}
		});
	}, [focusRow, controlsVisible]);

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
		<div className={css.container} onClick={showControls}>
			{/* Video/Audio Element - Hidden visually for audio mode */}
			<video
				ref={videoRef}
				className={css.videoPlayer}
				style={isAudioMode ? {opacity: 0, pointerEvents: 'none'} : undefined}
				autoPlay
				onLoadedMetadata={handleLoadedMetadata}
				onPlay={handlePlay}
				onPause={handlePause}
				onTimeUpdate={handleTimeUpdate}
				onWaiting={handleWaiting}
				onPlaying={handlePlaying}
				onEnded={handleEnded}
				onError={handleError}
			/>

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

			{/* Custom Subtitle Overlay - webOS doesn't support native <track> elements */}
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
					<div
						className={css.subtitleText}
						style={{
							fontSize: `${settings.subtitleSize === 'small' ? 36 : settings.subtitleSize === 'medium' ? 44 : settings.subtitleSize === 'large' ? 52 : 60}px`,
							backgroundColor: `${settings.subtitleBackgroundColor || '#000000'}${Math.round(((settings.subtitleBackground !== undefined ? settings.subtitleBackground : 75) / 100) * 255).toString(16).padStart(2, '0')}`,
							color: settings.subtitleColor || '#ffffff',
							textShadow: `0 0 ${settings.subtitleShadowBlur || 0.1}em ${settings.subtitleShadowColor || '#000000'}${Math.round(((settings.subtitleShadowOpacity !== undefined ? settings.subtitleShadowOpacity : 50) / 100) * 255).toString(16).padStart(2, '0')}`
						}}
						// eslint-disable-next-line react/no-danger
						dangerouslySetInnerHTML={{
							__html: currentSubtitleText
								.replace(/\\N/gi, '<br/>')
								.replace(/\r?\n/gi, '<br/>')
								.replace(/{\\.*?}/gi, '') // Remove ASS/SSA style tags
								.replace(/ {2,}/g, ' ')  // Collapse multiple spaces left by tag removal
								.trim()
						}}
					/>
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

			{/* Playback Speed Indicator */}
			{playbackRate !== 1 && (
				<div className={css.playbackIndicators}>
					<div className={css.speedIndicator}>{playbackRate}x</div>
				</div>
			)}

			{/* Next Episode Overlay */}
			{(showSkipCredits || showNextEpisode) && nextEpisode && !isAudioMode && !activeModal && !controlsVisible && (
				<NextEpisodeContainer className={css.nextEpisodeOverlay} spotlightRestrict="self-only">
					<div className={css.nextEpisodeCard}>
						<div className={css.nextThumbnail}>
							<img
								src={getImageUrl(getServerUrl(), nextEpisode.Id, 'Primary', {maxWidth: 400, quality: 80})}
								alt={nextEpisode.Name}
								className={css.nextThumbnailImg}
								onError={handleImageError}
							/>
							<div className={css.nextThumbnailGradient} />
						</div>
						<div className={css.nextInfo}>
							<div className={css.nextLabel}>UP NEXT</div>
							<div className={css.nextTitle}>{nextEpisode.Name}</div>
							{nextEpisode.SeriesName && (
								<div className={css.nextMeta}>
									S{nextEpisode.ParentIndexNumber} E{nextEpisode.IndexNumber} &middot; {nextEpisode.SeriesName}
								</div>
							)}
							<div className={css.nextActions}>
								<SpottableButton
									className={css.nextPlayBtn}
									onClick={handlePlayNextEpisode}
									data-spot-default="true"
								>
									&#9654; Play Now
								</SpottableButton>
								<SpottableButton
									className={css.nextCancelBtn}
									onClick={cancelNextEpisodeCountdown}
								>
									Hide
								</SpottableButton>
							</div>
						</div>
					</div>
					{nextEpisodeCountdown !== null && (
						<div className={css.nextProgressBar}>
							<div
								className={css.nextProgressFill}
								style={{width: `${((15 - nextEpisodeCountdown) / 15) * 100}%`}}
							/>
						</div>
					)}
				</NextEpisodeContainer>
			)}

			<PlayerControls
				css={css}
				controlsVisible={controlsVisible}
				activeModal={activeModal}
				isAudioMode={isAudioMode}
				focusRow={focusRow}
				title={title}
				subtitle={subtitle}
				topButtons={topButtons}
				bottomButtons={bottomButtons}
				displayTime={displayTime}
				duration={duration}
				progressPercent={progressPercent}
				isSeeking={isSeeking}
				seekPosition={seekPosition}
				item={item}
				mediaSourceId={mediaSourceId}
				playMethod={playMethod}
				playbackRate={playbackRate}
				selectedAudioIndex={selectedAudioIndex}
				selectedSubtitleIndex={selectedSubtitleIndex}
				selectedQuality={selectedQuality}
				audioStreams={audioStreams}
				subtitleStreams={subtitleStreams}
				chapters={chapters}
				currentTime={currentTime}
				subtitleOffset={subtitleOffset}
				showSkipIntro={showSkipIntro}
				handleControlButtonClick={handleControlButtonClick}
				handleProgressClick={handleProgressClick}
				handleProgressKeyDown={handleProgressKeyDown}
				handleProgressBlur={handleProgressBlur}
				handleSkipIntro={handleSkipIntro}
				handleSelectAudio={handleSelectAudio}
				handleSelectSubtitle={handleSelectSubtitle}
				handleSubtitleKeyDown={handleSubtitleKeyDown}
				handleSelectSpeed={handleSelectSpeed}
				handleSelectQuality={handleSelectQuality}
				handleSelectChapter={handleSelectChapter}
				handleOpenSubtitleOffset={handleOpenSubtitleOffset}
				handleOpenSubtitleSettings={handleOpenSubtitleSettings}
				handleSubtitleOffsetChange={handleSubtitleOffsetChange}
				closeModal={closeModal}
				stopPropagation={stopPropagation}
				renderInfoPlaybackRows={({css: c, mediaSource, playMethod: pm}) => {
					const getTranscodeReason = () => {
						if (pm !== 'Transcode') return null;
						const url = mediaSource?.TranscodingUrl || '';
						if (url.includes('TranscodeReasons=')) {
							const match = url.match(/TranscodeReasons=([^&]+)/);
							if (match) {
								return decodeURIComponent(match[1]).split(',')
									.map(r => r.replace(/([A-Z])/g, ' $1').trim())
									.join(', ');
							}
						}
						return 'Unknown';
					};
					return pm === 'Transcode' ? (
						<div className={`${c.infoRow} ${c.infoWarning}`}>
							<span className={c.infoLabel}>Transcode Reason</span>
							<span className={c.infoValue}>{getTranscodeReason()}</span>
						</div>
					) : null;
				}}
				renderInfoVideoExtra={({css: c, videoStream}) => (
					videoStream?.BitDepth ? (
						<div className={c.infoRow}>
							<span className={c.infoLabel}>Bit Depth</span>
							<span className={c.infoValue}>{videoStream.BitDepth}-bit</span>
						</div>
					) : null
				)}
			/>
		</div>
	);
};

export default Player;
