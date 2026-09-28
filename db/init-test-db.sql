-- Separate database for `npm test`, so tests never touch dev data.
CREATE DATABASE quakes_test OWNER quakes;
