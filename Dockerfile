FROM node:24-slim

# eMudhra CA compromise (October 2026): Node.js before 22.23.4 / 24.22.1 /
# 26.12.1 trusts the leaked intermediates, so a network attacker could read
# ONE_SECRET. Node 20 never got the fix. The tag stays floating so rebuilds
# pick up future Node security patches; this fails the build if it ever
# resolves to a Node without the fix.
RUN node -e "const [a,b,c]=process.versions.node.split('.').map(Number); \
    const ok=a>=27||(a===26&&(b>12||(b===12&&c>=1)))||(a===24&&(b>22||(b===22&&c>=1)))||(a===22&&(b>23||(b===23&&c>=4))); \
    if(!ok){console.error('Node '+process.versions.node+' lacks the eMudhra CA fix: need 22.23.4+, 24.22.1+ or 26.12.1+');process.exit(1)}"

WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Copy source files BEFORE npm install
COPY tsconfig.json ./
COPY src/ ./src/

# Install dependencies without running prepare script
RUN npm install --ignore-scripts

# Build the application manually
RUN npm run build

# Set environment variables
ENV NODE_ENV=production

# Run the server
CMD ["node", "build/index.js"]
