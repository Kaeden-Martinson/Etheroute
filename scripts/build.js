const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src');
const publicDir = path.join(__dirname, '../public');
const distDir = path.join(__dirname, '../dist');

// Helper function to recursively copy files
function copyDirectory(src, dest, extensions = ['.js', '.json', '.html', '.css']) {
  // Create destination directory if it doesn't exist
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  // Read source directory
  const files = fs.readdirSync(src);

  files.forEach((file) => {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    const stat = fs.statSync(srcPath);

    if (stat.isDirectory()) {
      copyDirectory(srcPath, destPath, extensions);
    } else {
      const fileExt = path.extname(file);
      if (extensions.includes(fileExt)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`Copied: ${destPath}`);
      }
    }
  });
}

// Clear dist directory
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true });
}

// Copy src to dist
copyDirectory(srcDir, distDir);

// Copy public to dist/public
const distPublicDir = path.join(distDir, 'public');
if (fs.existsSync(publicDir)) {
  copyDirectory(publicDir, distPublicDir, ['.html', '.css', '.js', '.json', '.svg']);
}

console.log('Build complete! Files copied to dist/');

