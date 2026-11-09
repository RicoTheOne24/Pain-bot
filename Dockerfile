FROM node:22-bookworm

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version

COPY package*.json ./

RUN npm install
RUN npm install -g tsx

COPY . .

CMD ["tsx", "index.tsx"]
