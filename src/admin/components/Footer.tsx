import React from 'react';
import { AUTHOR_EMAIL, AUTHOR_NAME, copyrightYears } from '../../author.js';
import { TYPE } from '../tokens.js';

/** The copyright line at the bottom of every page of the panel. The name opens a new e-mail to the author. */
const Footer = () => (
  <footer style={{ padding: '16px 24px', textAlign: 'center', fontSize: TYPE.small, color: '#475569' }}>
    © {copyrightYears()}{' '}
    <a href={`mailto:${AUTHOR_EMAIL}`} title={`Write to ${AUTHOR_EMAIL}`}>
      {AUTHOR_NAME}
    </a>
  </footer>
);

export default Footer;
