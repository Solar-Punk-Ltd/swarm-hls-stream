import { ReactElement } from 'react';
import { Route, Routes } from 'react-router-dom';

import { MainLayout } from './layouts/Main/MainLayout';
import { StreamBrowser } from './pages/StreamBrowser/StreamBrowser';
import { StreamWatcher } from './pages/StreamWatcher/StreamWatcher';

export enum ROUTES {
  STREAM_BROWSER = '/',
  STREAM_WATCH = '/watch/:mediatype/:owner/:topic',
}

const BaseRouter = (): ReactElement => {
  return (
    <MainLayout>
      <Routes>
        <Route path={ROUTES.STREAM_BROWSER} element={<StreamBrowser />} />
        <Route path={ROUTES.STREAM_WATCH} element={<StreamWatcher />} />
      </Routes>
    </MainLayout>
  );
};

export default BaseRouter;
