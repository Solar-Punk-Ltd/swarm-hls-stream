import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { Button, ButtonVariant } from '@/components/Button/Button';
import { SwarmHlsPlayer } from '@/components/SwarmHlsPlayer/SwarmHlsPlayer';
import { ROUTES } from '@/routes';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType } from '@/types/stream';

import './StreamWatcher.scss';

const VALID_MEDIA_TYPES: MediaType[] = [MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO];

function isMediaType(value: string): value is MediaType {
  return VALID_MEDIA_TYPES.includes(value as MediaType);
}

export function StreamWatcher() {
  const { mediatype, owner, topic } = useParams<{
    mediatype: string;
    owner: string;
    topic: string;
  }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const handleBackButtonClick = () => {
    navigate(ROUTES.STREAM_BROWSER);
  };

  if (!mediatype || !owner || !topic || !isMediaType(mediatype)) {
    return <div>Invalid stream</div>;
  }

  const enableQoeOverlay = searchParams.get('qoe') === '1';

  return (
    <div className="stream-item-page">
      <SwarmHlsPlayer owner={owner} topicString={topic} mediaType={mediatype} enableQoeOverlay={enableQoeOverlay} />
      <Button variant={ButtonVariant.SECONDARY} onClick={() => handleBackButtonClick()}>
        Back
      </Button>
    </div>
  );
}
