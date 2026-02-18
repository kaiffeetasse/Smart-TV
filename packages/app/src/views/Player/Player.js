import {getPlatform} from '../../platform';
import {lazy, Suspense} from 'react';

const PlatformPlayer = lazy(() =>
	getPlatform() === 'tizen'
		? import('./TizenPlayer')
		: import('./WebOSPlayer')
);

const Player = (props) => (
	<Suspense fallback={null}>
		<PlatformPlayer {...props} />
	</Suspense>
);

export default Player;
