import { useNavigate, useParams } from 'react-router-dom';

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
  const navigate = useNavigate();

  const handleBackButtonClick = () => {
    navigate(ROUTES.STREAM_BROWSER);
  };

  if (!mediatype || !owner || !topic || !isMediaType(mediatype)) {
    return <div>Invalid stream</div>;
  }

  return (
    <div className="stream-item-page">
      <SwarmHlsPlayer owner={owner} topic={topic} mediatype={mediatype} />
      <Button variant={ButtonVariant.SECONDARY} onClick={() => handleBackButtonClick()}>
        Back
      </Button>
    </div>
  );
}
