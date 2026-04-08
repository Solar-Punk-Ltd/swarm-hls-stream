import React from 'react';

type ProfileIconProps = {
  color?: string;
  onClick?: () => void;
};

export const ProfileIcon: React.FC<ProfileIconProps> = ({ color, onClick }: ProfileIconProps) => {
  return (
    <div onClick={onClick}>
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <g clipPath="url(#clip0_88_760)">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M16 32C24.8366 32 32 24.8366 32 16C32 7.16344 24.8366 0 16 0C7.16344 0 0 7.16344 0 16C0 24.8366 7.16344 32 16 32ZM20 10C20 12.2091 18.2091 14 16 14C13.7909 14 12 12.2091 12 10C12 7.79086 13.7909 6 16 6C18.2091 6 20 7.79086 20 10ZM16 26C24 26 24 23.985 24 21.5C24 19.015 20.418 17 16 17C11.582 17 8 19.015 8 21.5C8 23.985 8 26 16 26Z"
            fill={color ? color : '#F9F7F7'}
          />
        </g>
        <defs>
          <clipPath id="clip0_88_760">
            <rect width="32" height="32" fill="white" />
          </clipPath>
        </defs>
      </svg>
    </div>
  );
};
