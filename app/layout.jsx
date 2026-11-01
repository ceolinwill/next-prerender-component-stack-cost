import { Nest } from './nest';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Nest depth={25}>{children}</Nest>
      </body>
    </html>
  );
}
