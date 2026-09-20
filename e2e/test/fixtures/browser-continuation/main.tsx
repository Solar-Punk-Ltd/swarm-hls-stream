import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { StreamWatcher } from '@/pages/StreamWatcher/StreamWatcher';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/watch/:mediatype/:owner/:topic" element={<StreamWatcher />} />
    </Routes>
  </BrowserRouter>,
);
