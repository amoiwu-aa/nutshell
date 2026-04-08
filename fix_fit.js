const fs = require('fs');
const glob = require('glob'); // use standard fs approach

const safeFit = `
        try {
          if (containerRef.current && containerRef.current.offsetWidth > 0 && containerRef.current.offsetHeight > 0) {
            if (terminalRef.current && (terminalRef.current as any)._core?._renderService) {
              // safe
            }
          }
        } catch(e) {}
`;

// It's easier just to patch the files directly using simple string replacement for known bad lines.
