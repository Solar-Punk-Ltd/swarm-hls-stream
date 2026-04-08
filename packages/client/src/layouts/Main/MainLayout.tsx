import Logo from '@/assets/images/sp-logo.png';
import { DomainSelector } from '@/components/DomainSelector/DomainSelector';

import './MainLayout.scss';

interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  return (
    <div className="main-layout" role="main-layout">
      <div className="upper-side"></div>
      <div className="main-layout-header">
        <img src={Logo} alt="logo" className="logo" />
        <DomainSelector />
      </div>
      <div className="content">{children}</div>
    </div>
  );
}
