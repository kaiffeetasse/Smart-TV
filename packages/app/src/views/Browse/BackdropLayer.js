import {useState, useEffect, useCallback, useRef, memo} from 'react';
import css from './Browse.module.less';

const BACKDROP_DEBOUNCE_MS = 500;

const BackdropLayer = memo(({targetUrl, blurAmount}) => {
	const [currentUrl, setCurrentUrl] = useState('');
	const [prevUrl, setPrevUrl] = useState(null);
	const [currentOpacity, setCurrentOpacity] = useState(1);
	const [prevOpacity, setPrevOpacity] = useState(0);

	const timeoutRef = useRef(null);
	const fadeIntervalRef = useRef(null);
	const pendingUrlRef = useRef(null);
	const currentUrlRef = useRef('');

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			if (fadeIntervalRef.current) clearTimeout(fadeIntervalRef.current);
		};
	}, []);

	const crossFade = useCallback(() => {
		setCurrentOpacity(0);
		setPrevOpacity(1);

		window.requestAnimationFrame(() => {
			setCurrentOpacity(1);
			setPrevOpacity(0);
		});

		if (fadeIntervalRef.current) {
			clearTimeout(fadeIntervalRef.current);
		}
		fadeIntervalRef.current = setTimeout(() => {
			setPrevUrl(null);
			fadeIntervalRef.current = null;
		}, 500);
	}, []);

	useEffect(() => {
		if (!targetUrl) {
			if (currentUrlRef.current) {
				setCurrentUrl('');
				setPrevUrl(null);
				currentUrlRef.current = '';
			}
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
				pendingUrlRef.current = null;
			}
			return;
		}

		if (pendingUrlRef.current === targetUrl || targetUrl === currentUrlRef.current) return;

		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}
		pendingUrlRef.current = targetUrl;
		timeoutRef.current = setTimeout(() => {
			const nextUrl = pendingUrlRef.current;
			const img = new window.Image();
			const apply = () => {
				window.requestAnimationFrame(() => {
					setPrevUrl(currentUrlRef.current);
					setCurrentUrl(nextUrl);
					currentUrlRef.current = nextUrl;
					crossFade();
				});
			};
			img.onload = apply;
			img.onerror = apply;
			img.src = nextUrl;
		}, BACKDROP_DEBOUNCE_MS);

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
				pendingUrlRef.current = null;
			}
		};
	}, [targetUrl, crossFade]);

	const blurStyle = blurAmount > 0
		? {WebkitFilter: `blur(${blurAmount}px)`, filter: `blur(${blurAmount}px)`}
		: {WebkitFilter: 'none', filter: 'none'};

	return (
		<div className={css.globalBackdrop}>
			{prevUrl && (
				<img
					className={css.globalBackdropImage}
					src={prevUrl}
					alt=""
					style={{
						...blurStyle,
						opacity: prevOpacity,
						transition: 'opacity 0.45s ease'
					}}
				/>
			)}

			{currentUrl && (
				<img
					className={css.globalBackdropImage}
					src={currentUrl}
					alt=""
					style={{
						...blurStyle,
						opacity: currentOpacity,
						transition: 'opacity 0.45s ease'
					}}
				/>
			)}
			<div className={css.globalBackdropOverlay} />
		</div>
	);
});

export default BackdropLayer;
