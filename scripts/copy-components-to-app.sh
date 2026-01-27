#!/bin/bash

# Script to copy component folders from components/ to app/components/

# Create app/components directory if it doesn't exist
mkdir -p app/components

# List of folders to copy
folders=(
  "ui"
  "portal"
  "AI"
  "ai"
  "chat"
  "compliance"
  "dashboard"
  "intelligence"
  "coordinator"
  "content-studio"
  "lender"
  "listing"
  "marketing"
  "mobile"
  "vendor"
  "video"
)

# Copy each folder recursively
for folder in "${folders[@]}"; do
  if [ -d "components/$folder" ]; then
    echo "Copying components/$folder/ to app/components/$folder/"
    cp -r "components/$folder" "app/components/$folder"
  else
    echo "Warning: components/$folder/ does not exist, skipping..."
  fi
done

echo "Component folder copy complete!"
echo ""
echo "Listing app/components/ structure:"
find app/components -type d | sort
