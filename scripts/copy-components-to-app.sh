#!/bin/bash

# Script to copy component folders from components/ to app/components/
# This preserves the exact folder structure

echo "Starting component folder migration..."

# Create app/components directory if it doesn't exist
mkdir -p app/components

# Copy each folder recursively
echo "Copying components/ui/ ..."
cp -r components/ui app/components/

echo "Copying components/portal/ ..."
cp -r components/portal app/components/

echo "Copying components/AI/ ..."
cp -r components/AI app/components/

echo "Copying components/ai/ ..."
cp -r components/ai app/components/

echo "Copying components/chat/ ..."
cp -r components/chat app/components/

echo "Copying components/compliance/ ..."
cp -r components/compliance app/components/

echo "Copying components/dashboard/ ..."
cp -r components/dashboard app/components/

echo "Copying components/intelligence/ ..."
cp -r components/intelligence app/components/

echo "Copying components/coordinator/ ..."
if [ -d "components/coordinator" ]; then
  cp -r components/coordinator app/components/
else
  echo "  (coordinator folder not found, skipping)"
fi

echo "Copying components/content-studio/ ..."
if [ -d "components/content-studio" ]; then
  cp -r components/content-studio app/components/
else
  echo "  (content-studio folder not found, skipping)"
fi

echo "Copying components/lender/ ..."
if [ -d "components/lender" ]; then
  cp -r components/lender app/components/
else
  echo "  (lender folder not found, skipping)"
fi

echo "Copying components/listing/ ..."
cp -r components/listing app/components/

echo "Copying components/marketing/ ..."
cp -r components/marketing app/components/

echo "Copying components/mobile/ ..."
if [ -d "components/mobile" ]; then
  cp -r components/mobile app/components/
else
  echo "  (mobile folder not found, skipping)"
fi

echo "Copying components/vendor/ ..."
if [ -d "components/vendor" ]; then
  cp -r components/vendor app/components/
else
  echo "  (vendor folder not found, skipping)"
fi

echo "Copying components/video/ ..."
if [ -d "components/video" ]; then
  cp -r components/video app/components/
else
  echo "  (video folder not found, skipping)"
fi

echo ""
echo "✓ Component folder migration complete!"
echo ""
echo "Folder structure created in app/components/:"
tree -L 2 app/components/ 2>/dev/null || find app/components/ -maxdepth 2 -type d | sed 's|[^/]*/| |g'
